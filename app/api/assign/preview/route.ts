import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Shift = "matutino" | "vespertino" | "sabatino" | "dominical";
type Meeting = { day: number; start: number; end: number; shift: Shift };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };

const SHIFT_DAYS: Record<Shift, number[]> = {
  matutino: [1, 2, 3, 4, 5],  // L-V
  vespertino: [1, 2, 3, 4, 5],
  sabatino: [6],              // Sáb
  dominical: [7],             // Dom
};
const SHIFTS: Shift[] = ["matutino", "vespertino", "sabatino", "dominical"];

function hhmmToMin(hhmm: string) {
  const [h, m] = (hhmm || "00:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minToHHMM(m: number) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}
function overlap(a: Meeting, b: Meeting) {
  return a.day === b.day && Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

export async function POST() {
  try {
    // ========= 0) AJUSTES =========
    const { data: sRow } = await supabaseAdmin
      .from("system_settings")
      .select("settings")
      .eq("id", "general")
      .single();
    const S = (sRow?.settings ?? {}) as any;

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

    // ========= 1) DATOS =========
    const [{ data: elig }, { data: courses }, { data: rooms }, { data: students }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
      supabaseAdmin.from("students").select("id, shift, name"),
    ]);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];

    const studentShift = new Map<string, Shift | null>(
      (students ?? []).map((s: any) => [s.id, (s.shift ?? null) as Shift | null]),
    );
    const studentName = new Map<string, string | null>(
      (students ?? []).map((s: any) => [s.id, (s.name ?? null) as string | null]),
    );

    // demanda por curso (total y por turno) + elegibilidades por alumno (SET para evitar duplicados)
    const demandByCourseTotal = new Map<string, number>();
    const demandByCourseShift = new Map<string, Record<Shift, number>>();
    const eligByStudent = new Map<string, Set<string>>();

    for (const row of (elig ?? [])) {
      const sid = row.student_id as string;
      const cid = row.course_id as string;
      const sh = (studentShift.get(sid) || "matutino") as Shift;

      demandByCourseTotal.set(cid, (demandByCourseTotal.get(cid) || 0) + 1);

      const per = demandByCourseShift.get(cid) || { matutino: 0, vespertino: 0, sabatino: 0, dominical: 0 };
      per[sh] += 1;
      demandByCourseShift.set(cid, per);

      const set = eligByStudent.get(sid) || new Set<string>();
      set.add(cid);
      eligByStudent.set(sid, set);
    }

    // ========= 2) GENERAR SLOTS =========
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

    // ========= 3) PROGRAMACIÓN DE GRUPOS (slot-diversificado) =========
    // demanda restante por curso/turno
    const remainingDemand = new Map<string, Record<Shift, number>>();
    for (const [cid, per] of demandByCourseShift.entries()) {
      remainingDemand.set(cid, { ...per });
    }

    const roomsByCapacity = roomsArr.slice().sort((a, b) => b.capacity - a.capacity);
    const groupIndexMap = new Map<string, number>(); // `${cid}|${shift}` -> idx

    const scheduledGroups: Array<{
      ephemeral_id: string;
      course_id: string;
      shift: Shift;
      group_index: number;
      room_id: string;
      room_code: string;
      capacity: number;
      meeting: Meeting & { slot_index: number };
    }> = [];

    for (const shift of SHIFTS) {
      const slots = timeSlotsByShift[shift].slice().sort((a, b) => a.day - b.day || a.start - b.start);

      for (const s of slots) {
        const usedCoursesThisSlot = new Set<string>();

        for (const room of roomsByCapacity) {
          // elige curso con mayor demanda pendiente en este turno y no usado en este slot
          let bestCid: string | null = null;
          let bestDem = 0;

          for (const [cid, per] of remainingDemand.entries()) {
            const dem = Math.max(0, per[shift] || 0);
            if (dem > bestDem && !usedCoursesThisSlot.has(cid)) {
              bestCid = cid;
              bestDem = dem;
            }
          }

          if (!bestCid || bestDem <= 0) {
            // no demanda para este slot/salón -> queda vacío
            continue;
          }

          const key = `${bestCid}|${shift}`;
          const nextIdx = (groupIndexMap.get(key) || 0) + 1;
          groupIndexMap.set(key, nextIdx);

          scheduledGroups.push({
            ephemeral_id: `G-${bestCid}-${shift}-${nextIdx}`,
            course_id: bestCid,
            shift,
            group_index: nextIdx,
            room_id: room.id,
            room_code: room.code,
            capacity: room.capacity,
            meeting: { day: s.day, start: s.start, end: s.end, shift, slot_index: s.index },
          });

          usedCoursesThisSlot.add(bestCid);
          const per = remainingDemand.get(bestCid)!;
          per[shift] = Math.max(0, (per[shift] || 0) - room.capacity);
          remainingDemand.set(bestCid, per);
        }
      }
    }

    // ========= 4) ASIGNACIÓN ALUMNO->GRUPO (llenado por slot) =========
    // índice de grupos por (shift|day|start)
    const groupsByKey = new Map<string, typeof scheduledGroups>(); // key: `${shift}|${day}|${start}`
    for (const g of scheduledGroups) {
      const k = `${g.shift}|${g.meeting.day}|${g.meeting.start}`;
      const arr = groupsByKey.get(k) || [];
      arr.push(g);
      groupsByKey.set(k, arr);
    }

    // capacidad restante por grupo
    const remCap = new Map<string, number>();
    for (const g of scheduledGroups) remCap.set(g.ephemeral_id, g.capacity);

    const studentSchedule = new Map<string, Meeting[]>(); // agenda por alumno
    const studentLoad = new Map<string, number>(); // materias asignadas por alumno
    const proposed: { student_id: string; course_id: string; ephemeral_group_id: string }[] = [];

    // alumnos por turno (orden: menos elegibles primero)
    const studentsByShift: Record<Shift, string[]> = {
      matutino: [],
      vespertino: [],
      sabatino: [],
      dominical: [],
    };
    for (const sid of Array.from(eligByStudent.keys())) {
      const sh = (studentShift.get(sid) || "matutino") as Shift;
      studentsByShift[sh].push(sid);
    }
    for (const sh of SHIFTS) {
      studentsByShift[sh].sort(
        (a, b) => (eligByStudent.get(a)?.size || 0) - (eligByStudent.get(b)?.size || 0),
      );
    }

    // slots cronológicos globales
    const slotsChrono: Array<{ shift: Shift; day: number; start: number }> = [];
    for (const sh of SHIFTS) {
      for (const s of timeSlotsByShift[sh]) {
        slotsChrono.push({ shift: sh, day: s.day, start: s.start });
      }
    }
    slotsChrono.sort(
      (a, b) =>
        (a.shift === b.shift ? 0 : SHIFTS.indexOf(a.shift) - SHIFTS.indexOf(b.shift)) ||
        a.day - b.day ||
        a.start - b.start,
    );

    for (const slot of slotsChrono) {
      const k = `${slot.shift}|${slot.day}|${slot.start}`;
      const groupsHere = (groupsByKey.get(k) || [])
        .slice()
        .sort((g1, g2) => (remCap.get(g2.ephemeral_id)! - remCap.get(g1.ephemeral_id)!));

      if (groupsHere.length === 0) continue;

      const allowBreaks = allowBreaksByShift[slot.shift];
      const studentIds = studentsByShift[slot.shift];

      // recorre alumnos del turno e intenta sentarlos en ALGÚN grupo de este slot
      for (const sid of studentIds) {
        if ((studentLoad.get(sid) || 0) >= maxCoursesPerStudent) continue;

        const eligible = eligByStudent.get(sid) || new Set<string>();
        let sched = studentSchedule.get(sid) || [];

        // "sin descanso": si ya tiene algo este día, solo contiguo al bloque
        const daySched = sched.filter((s) => s.day === slot.day);
        const requireContiguous = !allowBreaks && daySched.length > 0;
        let minStart = Infinity,
          maxEnd = -Infinity;
        if (requireContiguous) {
          for (const s of daySched) {
            if (s.start < minStart) minStart = s.start;
            if (s.end > maxEnd) maxEnd = s.end;
          }
        }

        for (const g of groupsHere) {
          if ((remCap.get(g.ephemeral_id) || 0) <= 0) continue;
          if (!eligible.has(g.course_id)) continue;

          // misma hora exacta prohibida
          const sameHour = sched.some((s) => s.day === g.meeting.day && s.start === g.meeting.start);
          if (sameHour) continue;

          // no solapamiento
          const hasOverlap = sched.some((s) => overlap(s, g.meeting));
          if (hasOverlap) continue;

          // sin descanso (si aplica): contiguo al bloque del día
          if (requireContiguous) {
            const contiguous = g.meeting.end === minStart || g.meeting.start === maxEnd;
            if (!contiguous) continue;
          }

          // asignar
          proposed.push({ student_id: sid, course_id: g.course_id, ephemeral_group_id: g.ephemeral_id });
          remCap.set(g.ephemeral_id, (remCap.get(g.ephemeral_id) || 0) - 1);
          studentLoad.set(sid, (studentLoad.get(sid) || 0) + 1);

          sched = sched.concat([g.meeting]);
          studentSchedule.set(sid, sched);

          // solo UNA clase por slot por alumno
          break;
        }
      }
    }

    // ========= 5) SALIDAS =========
    const courseById = new Map(coursesArr.map((c) => [c.id, c]));

    // grupos con métricas y campos de orden
    const groupsUsage = scheduledGroups.map((g) => {
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
        fill_rate: g.capacity ? +(used / g.capacity).toFixed(2) : 0,
      };
    });

    // resumen por alumno
    const assignedCount = new Map<string, number>();
    for (const a of proposed) assignedCount.set(a.student_id, (assignedCount.get(a.student_id) || 0) + 1);

    const studentsIdsSet = new Set(eligByStudent.keys());
    const studentsOverview = Array.from(studentsIdsSet)
      .map((sid) => ({
        student_id: sid,
        student_name: (studentName.get(sid) || null) as string | null,
        shift: (studentShift.get(sid) || null) as Shift | null,
        assignments: assignedCount.get(sid) || 0,
        eligible: (eligByStudent.get(sid)?.size || 0),
      }))
      .sort((x, y) => {
        const sx = x.shift || "zzzz";
        const sy = y.shift || "zzzz";
        if (sx !== sy) return sx < sy ? -1 : 1;
        return y.assignments - x.assignments;
      });

    // detalle de asignaciones (para horarios de alumno)
    const groupById = new Map(scheduledGroups.map((g) => [g.ephemeral_id, g]));
    const assignmentsDetailed = proposed
      .map((a) => {
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

    // no asignados por curso (demanda total - asignados efectivos)
    const assignedByCourse = new Map<string, number>();
    for (const a of proposed) {
      assignedByCourse.set(a.course_id, (assignedByCourse.get(a.course_id) || 0) + 1);
    }
    const unassignedByCourse = [];
    for (const c of coursesArr) {
      const dem = demandByCourseTotal.get(c.id) || 0;
      const got = assignedByCourse.get(c.id) || 0;
      const miss = dem - got;
      if (miss > 0) {
        unassignedByCourse.push({ course_id: c.id, course_code: c.code || "", count: miss });
      }
    }

    return NextResponse.json({
      ok: true,
      params: {
        max_courses_per_student: maxCoursesPerStudent,
        start_matutino: S.start_matutino,
        duration_matutino: S.duration_matutino,
        allow_breaks_matutino: S.allow_breaks_matutino,
        slots_per_day_matutino: S.slots_per_day_matutino,
        start_vespertino: S.start_vespertino,
        duration_vespertino: S.duration_vespertino,
        allow_breaks_vespertino: S.allow_breaks_vespertino,
        slots_per_day_vespertino: S.slots_per_day_vespertino,
        start_sabatino: S.start_sabatino,
        duration_sabatino: S.duration_sabatino,
        allow_breaks_sabatino: S.allow_breaks_sabatino,
        slots_per_day_sabatino: S.slots_per_day_sabatino,
        start_dominical: S.start_dominical,
        duration_dominical: S.duration_dominical,
        allow_breaks_dominical: S.allow_breaks_dominical,
        slots_per_day_dominical: S.slots_per_day_dominical,
      },
      summary: {
        students_total: studentsIdsSet.size,
        courses_with_demand: Array.from(demandByCourseTotal.keys()).length,
        scheduled_groups: scheduledGroups.length,
        proposed_assignments: proposed.length,
      },
      unassigned_by_course: unassignedByCourse,
      scheduled_groups: groupsUsage,            // para vista "Materias" y horarios por salón
      students_overview: studentsOverview,      // para vista "Alumnos"
      assignments_detailed: assignmentsDetailed,// para horarios por alumno
      // catálogos para typeahead
      students_catalog: (students ?? []).map((s: any) => ({
        id: s.id as string,
        name: (s.name ?? null) as string | null,
        shift: (s.shift ?? null) as Shift | null,
      })),
      rooms_catalog: roomsArr.map((r) => ({ id: r.id, code: r.code, capacity: r.capacity })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
