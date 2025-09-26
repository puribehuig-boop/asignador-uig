import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Shift = "matutino" | "vespertino" | "sabatino" | "dominical";
type Meeting = { day: number; start: number; end: number; shift: Shift };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };

const SHIFT_DAYS: Record<Shift, number[]> = {
  matutino: [1,2,3,4,5],  // L-V
  vespertino: [1,2,3,4,5],
  sabatino: [6],          // Sábado
  dominical: [7],         // Domingo
};

function hhmmToMin(hhmm: string) { const [h,m] = hhmm.split(":").map(Number); return (h||0)*60+(m||0); }
function minToHHMM(m: number) { const h = Math.floor(m/60), mm = m%60; return `${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`; }
function overlap(a: Meeting, b: Meeting) { return a.day===b.day && Math.max(a.start,b.start) < Math.min(a.end,b.end); }

export async function POST() {
  try {
    // 0) Ajustes
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
    const maxCoursesPerStudent = Number(S.max_courses_per_student ?? 5);

    // 1) Datos
    const [{ data: elig }, { data: courses }, { data: rooms }, { data: students }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
      supabaseAdmin.from("students").select("id, shift"),
    ]);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];
    const studentShift = new Map<string, Shift | null>((students ?? []).map((s: any) => [s.id, (s.shift ?? null) as Shift | null]));

    // 2) Demanda por curso y turno
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

    // 3) Generar slots por turno: N slots consecutivos por día desde la hora de inicio
    const timeSlotsByShift: Record<Shift, { day: number; start: number; end: number; index: number }[]> = {
      matutino: [], vespertino: [], sabatino: [], dominical: []
    };
    (Object.keys(SHIFT_DAYS) as Shift[]).forEach(shift => {
      const start0 = startByShift[shift];
      const len = durationByShift[shift];
      const n = Math.max(1, slotsPerDayByShift[shift]);
      for (const day of SHIFT_DAYS[shift]) {
        for (let i = 0; i < n; i++) {
          const start = start0 + i * len;
          timeSlotsByShift[shift].push({ day, start, end: start + len, index: i + 1 });
        }
      }
    });

    // 4) Espacios (room x slot) por turno
    const allSlotsByShift: Record<Shift, { key: string; room: Room; slot: { day: number; start: number; end: number; index: number } }[]> = {
      matutino: [], vespertino: [], sabatino: [], dominical: []
    };
    for (const room of roomsArr) {
      (Object.keys(timeSlotsByShift) as Shift[]).forEach(shift => {
        for (const s of timeSlotsByShift[shift]) {
          allSlotsByShift[shift].push({ key: `${room.id}|${s.day}|${s.start}`, room, slot: s });
        }
      });
    }

    // 5) Programar grupos por curso/turno hasta cubrir demanda (greedy por capacidad)
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

      (Object.keys(perShift) as Shift[]).forEach((shift) => {
        let demand = perShift[shift];
        if (demand <= 0) return;

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
      });
    }

    // 6) Asignación alumno→grupo (mismo turno, sin choques)
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
      if ((studentLoad.get(sid) || 0) >= maxCoursesPerStudent) continue;

      const eligibleCourses = (eligByStudent.get(sid) || [])
        .slice()
        .sort((a,b) => {
          const dA = demandByCourseTotal.get(a) || 0, dB = demandByCourseTotal.get(b) || 0;
          const cA = scheduledCapByCourse.get(a) || 0, cB = scheduledCapByCourse.get(b) || 0;
          const rA = cA>0 ? dA/cA : Infinity, rB = cB>0 ? dB/cB : Infinity;
          return rB - rA;
        });

      const sched = studentSchedule.get(sid) || [];

      for (const cid of eligibleCourses) {
        if ((studentLoad.get(sid) || 0) >= maxCoursesPerStudent) break;

        const gs = (groupsByCourse.get(cid) || [])
          .filter(g => g.shift === sh)
          .slice()
          .sort((g1,g2) => ((remCap.get(g2.ephemeral_id)||0) - (remCap.get(g1.ephemeral_id)||0)));

        let placed = false;
        for (const g of gs) {
          if ((remCap.get(g.ephemeral_id) || 0) <= 0) continue;

          const hasOverlap = sched.some(s => overlap(s, g.meeting));
          if (hasOverlap) continue;

          proposed.push({ student_id: sid, course_id: cid, ephemeral_group_id: g.ephemeral_id });
          remCap.set(g.ephemeral_id, (remCap.get(g.ephemeral_id) || 0) - 1);
          studentLoad.set(sid, (studentLoad.get(sid) || 0) + 1);
          studentSchedule.set(sid, sched.concat([g.meeting]));
          placed = true; break;
        }
        if (!placed) unassignedByCourse.set(cid, (unassignedByCourse.get(cid) || 0) + 1);
      }
    }

    // 7) Resumen
    const courseById = new Map(coursesArr.map(c => [c.id, c]));
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
        capacity: g.capacity,
        used,
        fill_rate: g.capacity ? +(used/g.capacity).toFixed(2) : 0,
      };
    });

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
        students_total: eligByStudent.size,
        courses_with_demand: groupsByCourse.size,
        scheduled_groups: scheduledGroups.length,
        proposed_assignments: proposed.length,
      },
      unassigned_by_course: Array.from(unassignedByCourse.entries()).map(([cid, n]) => ({
        course_id: cid,
        course_code: courseById.get(cid)?.code || "",
        count: n,
      })),
      scheduled_groups: groupsUsage,
      assignments_preview: proposed,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
