import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Shift = "matutino" | "vespertino" | "sabatino" | "dominical";
type Meeting = { day: number; start: number; end: number; shift: Shift };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };

const SHIFT_DAYS: Record<Shift, number[]> = {
  matutino: [1,2,3,4,5],
  vespertino: [1,2,3,4,5],
  sabatino: [6],
  dominical: [7],
};

const SHIFTS: Shift[] = ["matutino","vespertino","sabatino","dominical"];

function hhmmToMin(hhmm: string) { const [h,m] = hhmm.split(":").map(Number); return (h||0)*60+(m||0); }
function minToHHMM(m: number) { const h = Math.floor(m/60), mm = m%60; return `${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`; }
function overlap(a: Meeting, b: Meeting) { return a.day===b.day && Math.max(a.start,b.start) < Math.min(a.end,b.end); }

export async function POST() {
  try {
    // Ajustes
    const { data: sRow } = await supabaseAdmin.from("system_settings").select("settings").eq("id","general").single();
    const S = sRow?.settings ?? {};

    const startByShift: Record<Shift, number> = {
      matutino: hhmmToMin(S.start_matutino ?? "07:00"),
      vespertino: hhmmToMin(S.start_vespertino ?? "16:00"),
      sabatino: hhmmToMin(S.start_sabatino ?? "08:00"),
      dominical: hhmmToMin(S.start_dominical ?? "08:00"),
    };
    const durationByShift: Record<Shift, number> = {
      matutino: Number(S.duration_matutino ?? 90),
      vespertino: Number(S.duration_vespertino ?? 90),
      sabatino: Number(S.duration_sabatino ?? 90),
      dominical: Number(S.duration_dominical ?? 90),
    };
    const slotsPerDayByShift: Record<Shift, number> = {
      matutino: Number(S.slots_per_day_matutino ?? 5),
      vespertino: Number(S.slots_per_day_vespertino ?? 4),
      sabatino: Number(S.slots_per_day_sabatino ?? 4),
      dominical: Number(S.slots_per_day_dominical ?? 4),
    };
    const allowBreaksByShift: Record<Shift, boolean> = {
  matutino: Boolean(S.allow_breaks_matutino ?? true),
  vespertino: Boolean(S.allow_breaks_vespertino ?? true),
  sabatino: Boolean(S.allow_breaks_sabatino ?? true),
  dominical: Boolean(S.allow_breaks_dominical ?? true),
  };
    const maxCoursesPerStudent = Number(S.max_courses_per_student ?? 5);

    // Datos
    const [{ data: elig }, { data: courses }, { data: rooms }, { data: students }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
      supabaseAdmin.from("students").select("id, shift, name"),
    ]);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];
    const studentShift = new Map<string, Shift | null>((students ?? []).map((s: any) => [s.id, (s.shift ?? null) as Shift | null]));
    const studentName = new Map<string, string | null>((students ?? []).map((s: any) => [s.id, (s.name ?? null) as string | null]));

    // Demanda por curso y turno + mapa de elegibilidades por alumno
    const demandByCourseTotal = new Map<string, number>();
    const demandByCourseShift = new Map<string, Record<Shift, number>>();
    const eligByStudent = new Map<string, string[]>();

    for (const row of (elig ?? [])) {
      const sid = row.student_id;
      const cid = row.course_id;
      const sh = (studentShift.get(sid) || "matutino") as Shift;

      demandByCourseTotal.set(cid, (demandByCourseTotal.get(cid) || 0) + 1);

      const ps = demandByCourseShift.get(cid) || { matutino:0, vespertino:0, sabatino:0, dominical:0 };
      ps[sh] += 1;
      demandByCourseShift.set(cid, ps);

      const arr = eligByStudent.get(sid) || [];
      arr.push(cid);
      eligByStudent.set(sid, arr);
    }

    // 1) Generar N slots consecutivos por día desde la hora de inicio
    type Slot = { day: number; start: number; end: number; index: number };
    const timeSlotsByShift: Record<Shift, Slot[]> = { matutino: [], vespertino: [], sabatino: [], dominical: [] };

    for (const shift of SHIFTS) {
      const start0 = startByShift[shift];
      const len = durationByShift[shift];
      const n = Math.max(1, slotsPerDayByShift[shift]);
      for (const day of SHIFT_DAYS[shift]) {
        for (let i = 0; i < n; i++) {
          const start = start0 + i * len;
          timeSlotsByShift[shift].push({ day, start, end: start + len, index: i + 1 });
        }
      }
    }

    // 2) Espacios (room x slot)
    const allSlotsByShift: Record<Shift, { key: string; room: Room; slot: Slot }[]> = {
      matutino: [], vespertino: [], sabatino: [], dominical: []
    };

    for (const room of roomsArr) {
      for (const shift of SHIFTS) {
        for (const s of timeSlotsByShift[shift]) {
          allSlotsByShift[shift].push({ key: `${room.id}|${s.day}|${s.start}`, room, slot: s });
        }
      }
    }

    // 3) Programación greedy por capacidad
    const scheduledGroups: Array<{
      ephemeral_id: string;
      course_id: string;
      shift: Shift;
      group_index: number;
      room_id: string; room_code: string;
      capacity: number;
      meeting: Meeting & { slot_index: number };
    }> = [];
    const occupied = new Set<string>(); // room|day|start

    for (const c of coursesArr) {
      const perShift = demandByCourseShift.get(c.id) || { matutino:0, vespertino:0, sabatino:0, dominical:0 };

      for (const shift of SHIFTS) {
        let demand = perShift[shift];
        if (demand <= 0) continue;

        const slots = allSlotsByShift[shift]
          .slice()
          .sort((a,b) => b.room.capacity - a.room.capacity || a.slot.day - b.slot.day || a.slot.start - b.slot.start);

        let groupIdx = 1;
        for (const s of slots) {
          if (demand <= 0) break;
          if (occupied.has(s.key)) continue;

          occupied.add(s.key);
          scheduledGroups.push({
            ephemeral_id: `G-${c.id}-${shift}-${groupIdx}`,
            course_id: c.id,
            shift,
            group_index: groupIdx,
            room_id: s.room.id,
            room_code: s.room.code,
            capacity: s.room.capacity,
            meeting: { day: s.slot.day, start: s.slot.start, end: s.slot.end, shift, slot_index: s.slot.index },
          });
          groupIdx++;

          demand = Math.max(0, demand - s.room.capacity);
        }
      }
    }

    // 4) Asignación alumno->grupo
    const groupsByCourse = new Map<string, typeof scheduledGroups>();
    for (const g of scheduledGroups) {
      const arr = groupsByCourse.get(g.course_id) || [];
      arr.push(g); groupsByCourse.set(g.course_id, arr);
    }

    const remCap = new Map<string, number>(); for (const g of scheduledGroups) remCap.set(g.ephemeral_id, g.capacity);
    const studentSchedule = new Map<string, Meeting[]>(); const studentLoad = new Map<string, number>();
    const proposed: { student_id: string; course_id: string; ephemeral_group_id: string }[] = [];
    const unassignedByCourse = new Map<string, number>();

    const scheduledCapByCourse = new Map<string, number>();
    for (const g of scheduledGroups) {
      scheduledCapByCourse.set(g.course_id, (scheduledCapByCourse.get(g.course_id) || 0) + g.capacity);
    }

    const courseIds = coursesArr.map(c => c.id);
    courseIds.sort((a,b) => {
      const dA = demandByCourseTotal.get(a) || 0, dB = demandByCourseTotal.get(b) || 0;
      const cA = scheduledCapByCourse.get(a) || 0, cB = scheduledCapByCourse.get(b) || 0;
      const rA = cA>0 ? dA/cA : Infinity, rB = cB>0 ? dB/cB : Infinity;
      return rB - rA;
    });

    const studentsIds = Array.from(eligByStudent.keys());

for (const sid of studentsIds) {
  const sh = (studentShift.get(sid) || "matutino") as Shift;
  const allowBreaks = allowBreaksByShift[sh];

  if ((studentLoad.get(sid) || 0) >= maxCoursesPerStudent) continue;

  const eligibleCourses = (eligByStudent.get(sid) || [])
    .slice()
    .sort((a,b) => {
      const dA = demandByCourseTotal.get(a) || 0, dB = demandByCourseTotal.get(b) || 0;
      const cA = scheduledCapByCourse.get(a) || 0, cB = scheduledCapByCourse.get(b) || 0;
      const rA = cA>0 ? dA/cA : Infinity, rB = cB>0 ? dB/cB : Infinity;
      return rB - rA;
    });

  // IMPORTANTE: sched debe actualizarse localmente tras cada asignacion
  let sched = studentSchedule.get(sid) || [];

  for (const cid of eligibleCourses) {
    if ((studentLoad.get(sid) || 0) >= maxCoursesPerStudent) break;

    // Grupos del curso en el mismo turno del alumno
    let gs = (groupsByCourse.get(cid) || []).filter(g => g.shift === sh);

    // Orden: si no se permiten descansos, prioriza mas temprano; si si, prioriza capacidad
    gs = gs.slice().sort((g1, g2) => {
      if (!allowBreaks) {
        return (g1.meeting.day - g2.meeting.day) || (g1.meeting.start - g2.meeting.start);
      }
      return ((remCap.get(g2.ephemeral_id) || 0) - (remCap.get(g1.ephemeral_id) || 0));
    });

    // Si no hay descansos y ya hay algo ese dia, intenta primero slots contiguos a su bloque
    if (!allowBreaks) {
      const perDay: Record<number, { min: number; max: number } | undefined> = {};
      for (const s of sched) {
        const d = s.day;
        perDay[d] = perDay[d]
          ? { min: Math.min(perDay[d]!.min, s.start), max: Math.max(perDay[d]!.max, s.end) }
          : { min: s.start, max: s.end };
      }
      const preferred: typeof gs = [];
      const others: typeof gs = [];
      for (const g of gs) {
        const blk = perDay[g.meeting.day];
        if (!blk) {
          // si aun no tiene nada ese dia, considerar normal (ya estan ordenados por hora)
          preferred.push(g);
        } else {
          const contiguous = (g.meeting.end === blk.min) || (g.meeting.start === blk.max);
          (contiguous ? preferred : others).push(g);
        }
      }
      gs = preferred.concat(others);
    }

    let placed = false;
    for (const g of gs) {
      if ((remCap.get(g.ephemeral_id) || 0) <= 0) continue;

      // Regla: misma hora exacta prohibida
      const sameHour = sched.some(s => s.day === g.meeting.day && s.start === g.meeting.start);
      if (sameHour) continue;

      // Regla: no solapamiento
      const hasOverlap = sched.some(s => overlap(s, g.meeting));
      if (hasOverlap) continue;

      // Regla: sin descanso (si aplica). Requiere contiguidad con el bloque del mismo dia.
      if (!allowBreaks) {
        const daySched = sched.filter(s => s.day === g.meeting.day);
        if (daySched.length > 0) {
          const minStart = Math.min(...daySched.map(s => s.start));
          const maxEnd = Math.max(...daySched.map(s => s.end));
          const contiguous = (g.meeting.end === minStart) || (g.meeting.start === maxEnd);
          if (!contiguous) continue;
        }
      }

      // Asignar
      proposed.push({ student_id: sid, course_id: cid, ephemeral_group_id: g.ephemeral_id });
      remCap.set(g.ephemeral_id, (remCap.get(g.ephemeral_id) || 0) - 1);
      studentLoad.set(sid, (studentLoad.get(sid) || 0) + 1);

      // ACTUALIZA sched local Y el mapa global (clave para evitar choques posteriores)
      sched = sched.concat([g.meeting]);
      studentSchedule.set(sid, sched);

      placed = true;
      break;
    }

    if (!placed) {
      unassignedByCourse.set(cid, (unassignedByCourse.get(cid) || 0) + 1);
    }
  }
}

    // 5) Salidas

    const courseById = new Map(coursesArr.map(c => [c.id, c]));
    // Grupos con métricas y campos para orden
    const groupsUsage = scheduledGroups.map(g => {
      const used = g.capacity - (remCap.get(g.ephemeral_id) || 0);
      return {
        course_code: courseById.get(g.course_id)?.code || "",
        turno: g.shift,
        group_index: g.group_index,
        room: g.room_code,
        day_of_week: g.meeting.day,
        slot_index: g.meeting.slot_index,
        start_time: minToHHMM(g.meeting.start),
        end_time: minToHHMM(g.meeting.end),
        start_min: g.meeting.start,
        end_min: g.meeting.end,
        capacity: g.capacity,
        used,
        fill_rate: g.capacity ? +(used/g.capacity).toFixed(2) : 0,
      };
    });

    // Conteos por alumno (para overview alumnos)
    const assignedCount = new Map<string, number>();
    for (const a of proposed) assignedCount.set(a.student_id, (assignedCount.get(a.student_id) || 0) + 1);

    const studentsIdsSet = new Set(studentsIds);
    const studentsOverview = Array.from(studentsIdsSet).map((sid) => ({
      student_id: sid,
      student_name: (studentName.get(sid) || null) as string | null,
      shift: (studentShift.get(sid) || null) as Shift | null,
      assignments: assignedCount.get(sid) || 0,
      eligible: (eligByStudent.get(sid) || []).length,
    }))
    .sort((x, y) => {
      const sx = x.shift || "zzzz", sy = y.shift || "zzzz";
      if (sx !== sy) return sx < sy ? -1 : 1;
      return y.assignments - x.assignments;
    });

    // Indice por grupo para construir horarios por alumno
    const groupById = new Map(scheduledGroups.map(g => [g.ephemeral_id, g]));
    const assignmentsDetailed = proposed
      .map(a => {
        const g = groupById.get(a.ephemeral_group_id);
        if (!g) return null;
        return {
          student_id: a.student_id,
          student_name: studentName.get(a.student_id) || null,
          shift: (studentShift.get(a.student_id) || null) as Shift | null,
          course_code: courseById.get(g.course_id)?.code || "",
          room_code: g.room_code,
          day_of_week: g.meeting.day,
          slot_index: g.meeting.slot_index,
          start_time: minToHHMM(g.meeting.start),
          end_time: minToHHMM(g.meeting.end),
          start_min: g.meeting.start,
          end_min: g.meeting.end,
        };
      })
      .filter(Boolean) as any[];

    return NextResponse.json({
      ok: true,
      params: {
        max_courses_per_student: maxCoursesPerStudent,
        start_matutino: S.start_matutino, duration_matutino: S.duration_matutino, allow_breaks_matutino: S.allow_breaks_matutino, slots_per_day_matutino: S.slots_per_day_matutino,
        start_vespertino: S.start_vespertino, duration_vespertino: S.duration_vespertino, allow_breaks_vespertino: S.allow_breaks_vespertino, slots_per_day_vespertino: S.slots_per_day_vespertino,
        start_sabatino: S.start_sabatino, duration_sabatino: S.duration_sabatino, allow_breaks_sabatino: S.allow_breaks_sabatino, slots_per_day_sabatino: S.slots_per_day_sabatino,
        start_dominical: S.start_dominical, duration_dominical: S.duration_dominical, allow_breaks_dominical: S.allow_breaks_dominical, slots_per_day_dominical: S.slots_per_day_dominical,
      },
      summary: {
        students_total: studentsIdsSet.size,
        courses_with_demand: new Set(coursesArr.map(c => c.id)).size,
        scheduled_groups: scheduledGroups.length,
        proposed_assignments: proposed.length,
      },
      unassigned_by_course: Array.from(unassignedByCourse.entries()).map(([cid, n]) => ({
        course_id: cid,
        course_code: courseById.get(cid)?.code || "",
        count: n,
      })),
      scheduled_groups: groupsUsage,            // para vista "Materias" y horarios por salón
      students_overview: studentsOverview,      // para vista "Alumnos"
      assignments_detailed: assignmentsDetailed,// para horarios por alumno
      // catálogos para typeahead
      students_catalog: (students ?? []).map((s: any) => ({ id: s.id as string, name: (s.name ?? null) as string | null, shift: (s.shift ?? null) as Shift | null })),
      rooms_catalog: roomsArr.map(r => ({ id: r.id, code: r.code, capacity: r.capacity })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
