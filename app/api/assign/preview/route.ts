import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Meeting = { day: number; start: number; end: number };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };

function hhmmToMin(hhmm: string) { const [h,m] = hhmm.split(":").map(Number); return (h||0)*60+(m||0); }
function minToHHMM(m: number) { const h = Math.floor(m/60), mm = m%60; return `${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`; }
function conflict(a: Meeting, b: Meeting) { return a.day===b.day && Math.max(a.start,b.start) < Math.min(a.end,b.end); }

export async function POST() {
  try {
    // 0) Carga ajustes desde DB
    const { data: sRow } = await supabaseAdmin
      .from("system_settings")
      .select("settings")
      .eq("id", "general")
      .single();

    const S = sRow?.settings ?? {
      max_courses_per_student: 5,
      target_group_size: 30,
      slot_length_minutes: 90,
      day_start: "07:00",
      day_end: "21:00",
      days_active: [1,2,3,4,5],
    };

    // 1) Datos base
    const [{ data: elig, error: e1 }, { data: courses, error: e2 }, { data: rooms, error: e3 }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
    ]);
    if (e1 || e2 || e3) throw (e1 || e2 || e3);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];

    // 2) Demanda y elegibilidades por alumno
    const demandByCourse = new Map<string, number>();
    const eligByStudent = new Map<string, string[]>();
    for (const row of elig ?? []) {
      demandByCourse.set(row.course_id, (demandByCourse.get(row.course_id) || 0) + 1);
      const arr = eligByStudent.get(row.student_id) || [];
      arr.push(row.course_id);
      eligByStudent.set(row.student_id, arr);
    }

    // 3) Slots generados por ajustes
    const dayStart = hhmmToMin(S.day_start);
    const dayEnd = hhmmToMin(S.day_end);
    const timeSlots: { day: number; start: number; end: number }[] = [];
    for (const day of (S.days_active?.length ? S.days_active : [1,2,3,4,5])) {
      for (let t = dayStart; t + S.slot_length_minutes <= dayEnd; t += S.slot_length_minutes) {
        timeSlots.push({ day, start: t, end: t + S.slot_length_minutes });
      }
    }

    // 4) Grupos deseados por curso
    const desiredGroups: { course_id: string; needed: number; demand: number }[] = [];
    for (const c of coursesArr) {
      const demand = demandByCourse.get(c.id) || 0;
      const needed = demand > 0 ? Math.ceil(demand / S.target_group_size) : 0;
      if (needed > 0) desiredGroups.push({ course_id: c.id, needed, demand });
    }
    desiredGroups.sort((a,b) => (a.demand/a.needed) < (b.demand/b.needed) ? 1 : -1);

    // 5) Asignar a cada grupo (salón + slot) disponibles
    const occupied = new Set<string>();
    const allSlots: { key: string; room: Room; slot: { day: number; start: number; end: number } }[] = [];
    for (const room of roomsArr) {
      for (const s of timeSlots) {
        allSlots.push({ key: `${room.id}|${s.day}|${s.start}`, room, slot: s });
      }
    }

    let slotIdx = 0;
    const scheduledGroups: Array<{
      ephemeral_id: string;
      course_id: string;
      group_index: number;
      room_id: string;
      room_code: string;
      capacity: number;
      meeting: Meeting;
    }> = [];

    for (const g of desiredGroups) {
      for (let i = 1; i <= g.needed; i++) {
        let placed = false, tries = 0;
        while (tries < allSlots.length) {
          const s = allSlots[slotIdx % allSlots.length]; slotIdx++; tries++;
          if (occupied.has(s.key)) continue;
          occupied.add(s.key);
          scheduledGroups.push({
            ephemeral_id: `G-${g.course_id}-${i}`,
            course_id: g.course_id,
            group_index: i,
            room_id: s.room.id,
            room_code: s.room.code,
            capacity: Math.min(S.target_group_size, s.room.capacity),
            meeting: { day: s.slot.day, start: s.slot.start, end: s.slot.end },
          });
          placed = true; break;
        }
        if (!placed) break;
      }
    }

    const scheduledByCourse = new Map<string, { cap: number }>();
    for (const g of scheduledGroups) {
      scheduledByCourse.set(g.course_id, { cap: (scheduledByCourse.get(g.course_id)?.cap || 0) + g.capacity });
    }

    const groupsByCourse = new Map<string, typeof scheduledGroups>();
    for (const g of scheduledGroups) {
      const arr = groupsByCourse.get(g.course_id) || [];
      arr.push(g); groupsByCourse.set(g.course_id, arr);
    }

    const remCap = new Map<string, number>(); for (const g of scheduledGroups) remCap.set(g.ephemeral_id, g.capacity);
    const studentSchedule = new Map<string, Meeting[]>(); const studentLoad = new Map<string, number>();
    const proposed: { student_id: string; course_id: string; ephemeral_group_id: string }[] = [];
    const unassignedByCourse = new Map<string, number>();

    const courseByScarcity = desiredGroups.map(x => x.course_id).sort((a,b) => {
      const dA = demandByCourse.get(a) || 0, dB = demandByCourse.get(b) || 0;
      const cA = scheduledByCourse.get(a)?.cap || 0, cB = scheduledByCourse.get(b)?.cap || 0;
      const rA = cA > 0 ? dA/cA : Infinity, rB = cB > 0 ? dB/cB : Infinity;
      return rB - rA;
    });

    const students = Array.from(eligByStudent.keys());

    for (const sid of students) {
      if ((studentLoad.get(sid) || 0) >= S.max_courses_per_student) continue;
      const eligibleCourses = (eligByStudent.get(sid) || []).slice().sort((a,b) => {
        const dA = demandByCourse.get(a) || 0, dB = demandByCourse.get(b) || 0;
        const cA = scheduledByCourse.get(a)?.cap || 0, cB = scheduledByCourse.get(b)?.cap || 0;
        const rA = cA > 0 ? dA/cA : Infinity, rB = cB > 0 ? dB/cB : Infinity;
        return rB - rA;
      });

      const sched = studentSchedule.get(sid) || [];

      for (const cid of eligibleCourses) {
        if ((studentLoad.get(sid) || 0) >= S.max_courses_per_student) break;
        const gs = (groupsByCourse.get(cid) || []).slice()
          .sort((g1,g2) => ( (remCap.get(g2.ephemeral_id)||0) - (remCap.get(g1.ephemeral_id)||0) ));
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
        if (!placed) {
          unassignedByCourse.set(cid, (unassignedByCourse.get(cid) || 0) + 1);
        }
      }
    }

    const courseById = new Map(coursesArr.map(c => [c.id, c]));
    const groupsUsage = scheduledGroups.map(g => {
      const used = g.capacity - (remCap.get(g.ephemeral_id) || 0);
      return {
        course_code: courseById.get(g.course_id)?.code || "",
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
