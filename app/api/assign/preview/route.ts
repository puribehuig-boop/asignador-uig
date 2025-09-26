import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Shift = "matutino" | "vespertino" | "sabatino" | "dominical";
type Meeting = { day: number; start: number; end: number; shift: Shift };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };
type Student = { id: string; shift: Shift | null };

const SHIFT_DAYS: Record<Shift, number[]> = {
  matutino: [1,2,3,4,5],      // L-V
  vespertino: [1,2,3,4,5],    // L-V
  sabatino: [6],              // Sábado
  dominical: [7],             // Domingo
};

function hhmmToMin(hhmm: string) { const [h,m] = hhmm.split(":").map(Number); return (h||0)*60+(m||0); }
function minToHHMM(m: number) { const h = Math.floor(m/60), mm = m%60; return `${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`; }
function conflict(a: Meeting, b: Meeting) { return a.day===b.day && Math.max(a.start,b.start)<Math.min(a.end,b.end); }

export async function POST() {
  try {
    // 0) Cargar ajustes
    const { data: sRow } = await supabaseAdmin.from("system_settings").select("settings").eq("id","general").single();
    const S = sRow?.settings ?? {
      max_courses_per_student: 5,
      target_group_size: 30,
      slot_length_minutes: 90,
      start_matutino: "07:00",
      start_vespertino: "16:00",
      start_sabatino: "08:00",
      start_dominical: "08:00",
    };

    // 1) Datos base
    const [{ data: elig }, { data: courses }, { data: rooms }, { data: students }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
      supabaseAdmin.from("students").select("id, shift"),
    ]);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];
    const studentShift = new Map((students ?? []).map((s: any) => [s.id, (s.shift ?? null) as Shift | null]));

    // 2) Demanda total y por turno
    const demandByCourse = new Map<string, number>();
    const demandByCourseShift = new Map<string, Record<Shift, number>>();
    const eligByStudent = new Map<string, string[]>();

    for (const row of (elig ?? [])) {
      const sid = row.student_id;
      const cid = row.course_id;
      const sh = (studentShift.get(sid) || "matutino") as Shift; // default: matutino si no viene

      demandByCourse.set(cid, (demandByCourse.get(cid) || 0) + 1);

      const perShift = demandByCourseShift.get(cid) || { matutino:0, vespertino:0, sabatino:0, dominical:0 };
      perShift[sh] += 1;
      demandByCourseShift.set(cid, perShift);

      const arr = eligByStudent.get(sid) || [];
      arr.push(cid);
      eligByStudent.set(sid, arr);
    }

    // 3) Generar slots por turno (un slot por día/turno)
    const starts: Record<Shift,string> = {
      matutino: S.start_matutino, vespertino: S.start_vespertino,
      sabatino: S.start_sabatino, dominical: S.start_dominical
    };
    const timeSlotsByShift: Record<Shift, { day: number; start: number; end: number }[]> = {
      matutino: [], vespertino: [], sabatino: [], dominical: []
    };
    (Object.keys(SHIFT_DAYS) as Shift[]).forEach(shift => {
      const start = starts[shift]; const startMin = hhmmToMin(start);
      for (const day of SHIFT_DAYS[shift]) {
        timeSlotsByShift[shift].push({ day, start: startMin, end: startMin + S.slot_length_minutes });
      }
    });

    // 4) Calcular # de grupos por curso y por turno (en proporción a la demanda por turno)
    type Needed = { course_id: string; shift: Shift; needed: number; demand: number };
    const neededGroups: Needed[] = [];
    for (const c of coursesArr) {
      const demand = demandByCourse.get(c.id) || 0;
      if (!demand) continue;
      const perShift = demandByCourseShift.get(c.id) || { matutino:0, vespertino:0, sabatino:0, dominical:0 };
      (Object.keys(perShift) as Shift[]).forEach((shift) => {
        const d = perShift[shift];
        if (d > 0) {
          const needed = Math.ceil(d / S.target_group_size);
          if (needed > 0) neededGroups.push({ course_id: c.id, shift, needed, demand: d });
        }
      });
    }

    // Ordenar por “tensión” por turno
    neededGroups.sort((a,b) => (a.demand/a.needed) < (b.demand/b.needed) ? 1 : -1);

    // 5) Asignar para cada grupo un (salón + slot) del turno correspondiente
    const occupied = new Set<string>(); // room|day|start
    const allSlotsByShift: Record<Shift, { key: string; room: Room; slot: { day:number; start:number; end:number } }[]> = {
      matutino: [], vespertino: [], sabatino: [], dominical: []
    };
    for (const room of roomsArr) {
      (Object.keys(timeSlotsByShift) as Shift[]).forEach(shift => {
        for (const s of timeSlotsByShift[shift]) {
          allSlotsByShift[shift].push({ key: `${room.id}|${s.day}|${s.start}`, room, slot: s });
        }
      });
    }

    let slotIdxByShift: Record<Shift, number> = { matutino:0, vespertino:0, sabatino:0, dominical:0 };

    const scheduledGroups: Array<{
      ephemeral_id: string;
      course_id: string;
      group_index: number;
      shift: Shift;
      room_id: string;
      room_code: string;
      capacity: number;
      meeting: Meeting;
    }> = [];

    for (const g of neededGroups) {
      for (let i=1; i<=g.needed; i++) {
        let placed = false, tries = 0;
        const list = allSlotsByShift[g.shift];
        if (!list.length) break; // si no hay slots para ese turno, no se programa

        while (tries < list.length) {
          const s = list[slotIdxByShift[g.shift] % list.length]; slotIdxByShift[g.shift]++; tries++;
          if (occupied.has(s.key)) continue;
          occupied.add(s.key);
          scheduledGroups.push({
            ephemeral_id: `G-${g.course_id}-${g.shift}-${i}`,
            course_id: g.course_id,
            group_index: i,
            shift: g.shift,
            room_id: s.room.id,
            room_code: s.room.code,
            capacity: Math.min(S.target_group_size, s.room.capacity),
            meeting: { day: s.slot.day, start: s.slot.start, end: s.slot.end, shift: g.shift },
          });
          placed = true; break;
        }
        if (!placed) break;
      }
    }

    // Mapa por curso y turno
    const groupsByCourse = new Map<string, typeof scheduledGroups>();
    for (const g of scheduledGroups) {
      const arr = groupsByCourse.get(g.course_id) || [];
      arr.push(g); groupsByCourse.set(g.course_id, arr);
    }

    // 6) Asignar alumnos: solo a grupos de su mismo turno
    const remCap = new Map<string, number>(); for (const g of scheduledGroups) remCap.set(g.ephemeral_id, g.capacity);
    const studentSchedule = new Map<string, Meeting[]>(); const studentLoad = new Map<string, number>();
    const proposed: { student_id: string; course_id: string; ephemeral_group_id: string }[] = [];
    const unassignedByCourse = new Map<string, number>();

    const scheduledCapByCourse = new Map<string, number>();
    for (const g of scheduledGroups) {
      scheduledCapByCourse.set(g.course_id, (scheduledCapByCourse.get(g.course_id) || 0) + g.capacity);
    }

    const courseByScarcity = Array.from(new Set(neededGroups.map(x => x.course_id))).sort((a,b) => {
      const dA = demandByCourse.get(a) || 0, dB = demandByCourse.get(b) || 0;
      const cA = scheduledCapByCourse.get(a) || 0, cB = scheduledCapByCourse.get(b) || 0;
      const rA = cA>0 ? dA/cA : Infinity, rB = cB>0 ? dB/cB : Infinity;
      return rB - rA;
    });

    const studentsIds = Array.from(eligByStudent.keys());

    for (const sid of studentsIds) {
      const sh = (studentShift.get(sid) || "matutino") as Shift;
      if ((studentLoad.get(sid) || 0) >= S.max_courses_per_student) continue;

      const eligibleCourses = (eligByStudent.get(sid) || []).slice().sort((a,b) => {
        const dA = demandByCourse.get(a) || 0, dB = demandByCourse.get(b) || 0;
        const cA = scheduledCapByCourse.get(a) || 0, cB = scheduledCapByCourse.get(b) || 0;
        const rA = cA>0 ? dA/cA : Infinity, rB = cB>0 ? dB/cB : Infinity;
        return rB - rA;
      });

      const sched = studentSchedule.get(sid) || [];

      for (const cid of eligibleCourses) {
        if ((studentLoad.get(sid) || 0) >= S.max_courses_per_student) break;

        const gs = (groupsByCourse.get(cid) || [])
          .filter(g => g.shift === sh)
          .slice()
          .sort((g1,g2) => ((remCap.get(g2.ephemeral_id)||0) - (remCap.get(g1.ephemeral_id)||0)));

        let placed = false;
        for (const g of gs) {
          if ((remCap.get(g.ephemeral_id) || 0) <= 0) continue;
          const mt = g.meeting;
          if (sched.some(s => conflict(s, mt))) continue;

          proposed.push({ student_id: sid, course_id: cid, ephemeral_group_id: g.ephemeral_id });
          remCap.set(g.ephemeral_id, (remCap.get(g.ephemeral_id) || 0) - 1);
          studentLoad.set(sid, (studentLoad.get(sid) || 0) + 1);
          studentSchedule.set(sid, sched.concat([mt]));
          placed = true; break;
        }
        if (!placed) unassignedByCourse.set(cid, (unassignedByCourse.get(cid) || 0) + 1);
      }
    }

    const courseById = new Map(coursesArr.map(c => [c.id, c]));
    const groupsUsage = scheduledGroups.map(g => {
      const used = g.capacity - (remCap.get(g.ephemeral_id) || 0);
      return {
        course_code: courseById.get(g.course_id)?.code || "",
        turno: g.shift,
        group_index: g.group_index,
        room: g.room_code,
        day_of_week: g.meeting.day,
        start_time: minToHHMM(g.meeting.start),
        end_time: minToHHMM(g.meeting.end),
        capacity: g.capacity,
        used,
        fill_rate: g.capacity ? +(used/g.capacity).toFixed(2) : 0,
      };
    });

    return NextResponse.json({
      ok: true,
      params: S,
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
