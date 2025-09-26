import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Meeting = { day: number; start: number; end: number };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };

function hhmmToMin(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minToHHMM(m: number) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}
function conflict(a: Meeting, b: Meeting) {
  return a.day === b.day && Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    // Config por default (todo editable desde el UI de /assign)
    const maxCourses = Math.max(1, Number(body?.max_courses_per_student ?? 5));
    const targetGroupSize = Math.max(5, Number(body?.target_group_size ?? 30));
    const slotMinutes = Math.max(45, Number(body?.slot_length_minutes ?? 90));
    const startHHMM: string = body?.day_start ?? "07:00";
    const endHHMM: string = body?.day_end ?? "21:00";
    const daysActive: number[] = Array.isArray(body?.days_active) && body.days_active.length
      ? body.days_active.map((d: any) => Number(d)).filter((d: number) => d >= 1 && d <= 7)
      : [1, 2, 3, 4, 5]; // L-V

    // 1) Datos base
    const [{ data: elig, error: e1 }, { data: courses, error: e2 }, { data: rooms, error: e3 }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
    ]);
    if (e1 || e2 || e3) throw (e1 || e2 || e3);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];

    // 2) Demanda por curso y mapa de elegibles por alumno
    const demandByCourse = new Map<string, number>();
    const eligByStudent = new Map<string, string[]>();
    for (const row of elig ?? []) {
      demandByCourse.set(row.course_id, (demandByCourse.get(row.course_id) || 0) + 1);
      const arr = eligByStudent.get(row.student_id) || [];
      arr.push(row.course_id);
      eligByStudent.set(row.student_id, arr);
    }

    // 3) Generar slots por día/horario
    const dayStart = hhmmToMin(startHHMM);
    const dayEnd = hhmmToMin(endHHMM);
    const timeSlots: { day: number; start: number; end: number }[] = [];
    for (const day of daysActive) {
      for (let t = dayStart; t + slotMinutes <= dayEnd; t += slotMinutes) {
        timeSlots.push({ day, start: t, end: t + slotMinutes });
      }
    }

    // 4) Decidir número de grupos por curso
    const desiredGroups: { course_id: string; needed: number; demand: number }[] = [];
    for (const c of coursesArr) {
      const demand = demandByCourse.get(c.id) || 0;
      const needed = demand > 0 ? Math.ceil(demand / targetGroupSize) : 0;
      if (needed > 0) desiredGroups.push({ course_id: c.id, needed, demand });
    }

    // Ordenar cursos por “tensión” (más críticos primero)
    desiredGroups.sort((a, b) => {
      const rA = a.demand / a.needed; // aprox. promedio por grupo
      const rB = b.demand / b.needed;
      return rB - rA;
    });

    // 5) Asignar a cada grupo un (salón + slot) disponible
    // Ocupación: room_id+day+start -> ocupado
    const occupied = new Set<string>();
    const allSlots: { key: string; room: Room; slot: { day: number; start: number; end: number } }[] = [];
    for (const room of roomsArr) {
      for (const s of timeSlots) {
        const key = `${room.id}|${s.day}|${s.start}`;
        allSlots.push({ key, room, slot: s });
      }
    }

    // Round-robin sobre slots para repartir horarios
    let slotIdx = 0;
    const scheduledGroups: Array<{
      ephemeral_id: string; // id temporal
      course_id: string;
      group_index: number; // 1..N
      room_id: string;
      room_code: string;
      capacity: number;
      meeting: Meeting;
    }> = [];

    for (const g of desiredGroups) {
      for (let i = 1; i <= g.needed; i++) {
        // busca siguiente slot libre
        let placed = false;
        let tries = 0;
        while (tries < allSlots.length) {
          const s = allSlots[slotIdx % allSlots.length];
          slotIdx++; tries++;
          if (occupied.has(s.key)) continue;
          // asigna
          occupied.add(s.key);
          scheduledGroups.push({
            ephemeral_id: `G-${g.course_id}-${i}`,
            course_id: g.course_id,
            group_index: i,
            room_id: s.room.id,
            room_code: s.room.code,
            capacity: Math.min(targetGroupSize, s.room.capacity),
            meeting: { day: s.slot.day, start: s.slot.start, end: s.slot.end },
          });
          placed = true;
          break;
        }
        if (!placed) {
          // No hay más slots disponibles → no se programa este grupo
          break;
        }
      }
    }

    // Capacidad programada por curso
    const scheduledByCourse = new Map<string, { cap: number; groups: number }>();
    for (const g of scheduledGroups) {
      const prev = scheduledByCourse.get(g.course_id) || { cap: 0, groups: 0 };
      prev.cap += g.capacity;
      prev.groups += 1;
      scheduledByCourse.set(g.course_id, prev);
    }

    // 6) Asignar alumnos a grupos (greedy)
    const groupsByCourse = new Map<string, typeof scheduledGroups>();
    for (const g of scheduledGroups) {
      const arr = groupsByCourse.get(g.course_id) || [];
      arr.push(g);
      groupsByCourse.set(g.course_id, arr);
    }

    // capacidad restante por grupo
    const remCap = new Map<string, number>();
    for (const g of scheduledGroups) remCap.set(g.ephemeral_id, g.capacity);

    // horario acumulado por alumno
    const studentSchedule = new Map<string, Meeting[]>();
    const studentLoad = new Map<string, number>();
    const proposed: { student_id: string; course_id: string; ephemeral_group_id: string }[] = [];
    const unassignedByCourse = new Map<string, number>();

    // Ordenar cursos por escasez (demanda / capacidad programada)
    const courseIds = desiredGroups.map((x) => x.course_id);
    courseIds.sort((a, b) => {
      const dA = demandByCourse.get(a) || 0;
      const dB = demandByCourse.get(b) || 0;
      const cA = scheduledByCourse.get(a)?.cap || 0;
      const cB = scheduledByCourse.get(b)?.cap || 0;
      const rA = cA > 0 ? dA / cA : Infinity;
      const rB = cB > 0 ? dB / cB : Infinity;
      return rB - rA;
    });

    // Construir lista de alumnos
    const students = Array.from(eligByStudent.keys());

    for (const sid of students) {
      if ((studentLoad.get(sid) || 0) >= maxCourses) continue;
      // cursos elegibles del alumno, priorizando los más escasos
      const eligibleCourses = (eligByStudent.get(sid) || []).slice().sort((a, b) => {
        const dA = demandByCourse.get(a) || 0;
        const dB = demandByCourse.get(b) || 0;
        const cA = scheduledByCourse.get(a)?.cap || 0;
        const cB = scheduledByCourse.get(b)?.cap || 0;
        const rA = cA > 0 ? dA / cA : Infinity;
        const rB = cB > 0 ? dB / cB : Infinity;
        return rB - rA;
      });

      const sched = studentSchedule.get(sid) || [];

      for (const cid of eligibleCourses) {
        if ((studentLoad.get(sid) || 0) >= maxCourses) break;
        const gs = (groupsByCourse.get(cid) || [])
          .slice()
          .sort((g1, g2) => ( (remCap.get(g2.ephemeral_id) || 0) - (remCap.get(g1.ephemeral_id) || 0) ));

        let placed = false;
        for (const g of gs) {
          if ((remCap.get(g.ephemeral_id) || 0) <= 0) continue;
          const mt = g.meeting;
          const hasConf = sched.some((s) => conflict(s, mt));
          if (hasConf) continue;

          // asignar
          proposed.push({ student_id: sid, course_id: cid, ephemeral_group_id: g.ephemeral_id });
          remCap.set(g.ephemeral_id, (remCap.get(g.ephemeral_id) || 0) - 1);
          studentLoad.set(sid, (studentLoad.get(sid) || 0) + 1);
          studentSchedule.set(sid, sched.concat([mt]));
          placed = true;
          break;
        }
        if (!placed) {
          unassignedByCourse.set(cid, (unassignedByCourse.get(cid) || 0) + 1);
        }
      }
    }

    // 7) Resumen
    const courseById = new Map(coursesArr.map((c) => [c.id, c]));
    const groupsUsage = scheduledGroups.map((g) => {
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
        fill_rate: g.capacity ? +(used / g.capacity).toFixed(2) : 0,
      };
    });

    return NextResponse.json({
      ok: true,
      params: {
        max_courses_per_student: maxCourses,
        target_group_size: targetGroupSize,
        slot_length_minutes: slotMinutes,
        day_start: startHHMM,
        day_end: endHHMM,
        days_active: daysActive,
      },
      summary: {
        students_total: eligByStudent.size,
        courses_with_demand: desiredGroups.length,
        scheduled_groups: scheduledGroups.length,
        proposed_assignments: proposed.length,
      },
      unassigned_by_course: Array.from(unassignedByCourse.entries()).map(([cid, n]) => ({
        course_id: cid,
        course_code: courseById.get(cid)?.code || "",
        count: n,
      })),
      scheduled_groups: groupsUsage,               // grupos y horarios generados
      assignments_preview: proposed,               // alumno-curso-grupo (temporal)
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
