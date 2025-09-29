// app/api/assign/preview/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Shift = "matutino" | "vespertino" | "sabatino" | "dominical";
type Meeting = { day: number; start: number; end: number; shift: Shift };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };

const SHIFT_DAYS: Record<Shift, number[]> = {
  matutino: [1, 2, 3, 4, 5],
  vespertino: [1, 2, 3, 4, 5],
  sabatino: [6],
  dominical: [7],
};
const SHIFTS: Shift[] = ["matutino", "vespertino", "sabatino", "dominical"];

function hhmmToMin(s: string): number {
  const [hh, mm] = s.split(":").map((x) => +x);
  return hh * 60 + mm;
}
function minToHHMM(m: number): string {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const z = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${z(hh)}:${z(mm)}`;
}

export async function POST() {
  try {
    // ========= 0) AJUSTES =========
    // Intentamos leer system_settings (como en tu repo original).
    const { data: sRow } = await supabaseAdmin
      .from("system_settings")
      .select("settings")
      .eq("id", "general")
      .single();

    // Fallback: global_settings (si la vista/tabla system_settings no tuviera todo)
    const { data: gRows } = await supabaseAdmin
      .from("global_settings")
      .select("class_duration_min")
      .limit(1);

    const classDurationGlobal = Number(gRows?.[0]?.class_duration_min ?? 0) || null;

    const S = (sRow?.settings ?? {}) as any;

    const startByShift: Record<Shift, number> = {
      matutino: hhmmToMin(S.start_matutino ?? "07:00"),
      vespertino: hhmmToMin(S.start_vespertino ?? "16:00"),
      sabatino: hhmmToMin(S.start_sabatino ?? "08:00"),
      dominical: hhmmToMin(S.start_dominical ?? "08:00"),
    };
    const durationByShift: Record<Shift, number> = {
      matutino: Number(S.duration_matutino ?? classDurationGlobal ?? 90),
      vespertino: Number(S.duration_vespertino ?? classDurationGlobal ?? 90),
      sabatino: Number(S.duration_sabatino ?? classDurationGlobal ?? 90),
      dominical: Number(S.duration_dominical ?? classDurationGlobal ?? 90),
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

    // límites por alumno
    const maxCoursesPerStudent = Number(S.max_courses_per_student ?? 5);

    // Parámetros de apertura de grupos
    const maxSectionsPerCoursePerSlot: number = Number(S.max_sections_per_course_per_slot ?? 2);
    const minFillRate: number | null =
      S.min_fill_rate !== undefined && S.min_fill_rate !== null
        ? Math.max(0, Math.min(1, Number(S.min_fill_rate)))
        : null;

    // ========= 1) DATOS =========
    const [{ data: elig }, { data: courses }, { data: rooms }, { data: students }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
      supabaseAdmin.from("students").select("id, shift, name"),
    ]);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];

    const studentShift = new Map<string, Shift>(
      (students ?? []).map((s: any) => [s.id as string, ((s.shift as Shift) ?? "matutino") as Shift]),
    );

    // ========= 2) ELEGIBILIDADES =========
    const eligByStudent = new Map<string, Set<string>>();
    const eligByCourse = new Map<string, Set<string>>();
    for (const e of elig ?? []) {
      const sid = e.student_id as string;
      const cid = e.course_id as string;
      if (!eligByStudent.has(sid)) eligByStudent.set(sid, new Set());
      if (!eligByCourse.has(cid)) eligByCourse.set(cid, new Set());
      eligByStudent.get(sid)!.add(cid);
      eligByCourse.get(cid)!.add(sid);
    }

    // ========= 3) SLOTS =========
    const timeSlotsByShift: Record<Shift, Array<{ day: number; start: number; end: number; shift: Shift; index: number }>> = {
      matutino: [],
      vespertino: [],
      sabatino: [],
      dominical: [],
    };
    for (const sh of SHIFTS) {
      const start = startByShift[sh];
      const dur = durationByShift[sh];
      const slots = slotsPerDayByShift[sh];
      let idx = 0;
      for (const day of SHIFT_DAYS[sh]) {
        for (let k = 0; k < slots; k++) {
          const s = start + k * dur;
          timeSlotsByShift[sh].push({ day, start: s, end: s + dur, shift: sh, index: idx++ });
        }
      }
    }

    // ========= 4) ESTADO GLOBAL DE ASIGNACIÓN (por alumno) =========
    const assignedCount = new Map<string, number>();                 // alumno -> total asignado
    const assignedCourses = new Map<string, Set<string>>();          // alumno -> set(curso_id)
    const assignedSlotsByDay = new Map<string, Map<number, Set<number>>>(); // key alumno|shift -> (day -> set(slot_index))

    // ========= 5) PROGRAMACIÓN Y ASIGNACIÓN GREEDY POR SLOT =========
    type ScheduledGroup = {
      ephemeral_id: string;
      course_id: string;
      shift: Shift;
      group_index: number;
      room_id: string;
      room_code: string;
      capacity: number;
      meeting: { day: number; start: number; end: number; shift: Shift; slot_index: number };
      assigned_students: string[];
    };
    const scheduledGroups: ScheduledGroup[] = [];

    const roomsByCapacity = roomsArr.slice().sort((a, b) => b.capacity - a.capacity);
    const largestRoomCap = roomsByCapacity[0]?.capacity ?? 0;

    const courseById = new Map(coursesArr.map((c) => [c.id, c]));

    // Función: ¿puede el alumno tomar este slot?
    const canTakeSlot = (sid: string, shift: Shift, day: number, slotIndex: number, allowBreaks: boolean): boolean => {
      const k = `${sid}|${shift}`;
      const dayMap = assignedSlotsByDay.get(k);
      // No 2 clases al mismo horario
      if (dayMap && dayMap.get(day)?.has(slotIndex)) return false;

      // Contigüidad si allowBreaks=false
      if (!allowBreaks) {
        const set = dayMap?.get(day) || new Set<number>();
        if (set.size > 0) {
          const minIdx = Math.min(...Array.from(set.values()));
          const maxIdx = Math.max(...Array.from(set.values()));
          const isAdjacent = slotIndex === minIdx - 1 || slotIndex === maxIdx + 1 || set.has(slotIndex);
          if (!isAdjacent) return false;
        }
      }
      return true;
    };

    // Por turno
    for (const shift of SHIFTS) {
      const allowBreaks = allowBreaksByShift[shift];
      const slots = timeSlotsByShift[shift].slice().sort((a, b) => a.day - b.day || a.start - b.start);
      const studentsInShift = (students ?? [])
        .filter((s: any) => (s.shift ?? "matutino") === shift)
        .map((s: any) => s.id as string);

      // Precalcular "grado de libertad" por alumno (menos elegibles primero ayuda)
      const eligibleCountByStudent = new Map<string, number>();
      for (const sid of studentsInShift) {
        eligibleCountByStudent.set(sid, (eligByStudent.get(sid)?.size ?? 0));
      }

      // groupIndex por curso para nombres consecutivos
      const groupIndexMap = new Map<string, number>(); // `${course_id}|${shift}` -> idx

      for (const s of slots) {
        // Pool de alumnos disponibles para ESTE slot (no sobrepasan su tope y libres en este horario)
        const pool: string[] = [];
        for (const sid of studentsInShift) {
          const left = (maxCoursesPerStudent - (assignedCount.get(sid) || 0));
          if (left <= 0) continue;
          if (!canTakeSlot(sid, shift, s.day, s.index, allowBreaks)) continue;
          pool.push(sid);
        }

        if (pool.length === 0) continue;

        // Demanda efectiva por curso en este slot (alumnos en pool elegibles y que aún no llevaron ese curso)
        const demandByCourse = new Map<string, number>();
        const candidatesByCourse = new Map<string, string[]>();
        for (const cid of courseById.keys()) {
          demandByCourse.set(cid, 0);
          candidatesByCourse.set(cid, []);
        }
        for (const sid of pool) {
          const eligs = eligByStudent.get(sid) || new Set<string>();
          const already = assignedCourses.get(sid) || new Set<string>();
          for (const cid of eligs) {
            if (already.has(cid)) continue; // no repetir curso
            demandByCourse.set(cid, (demandByCourse.get(cid) || 0) + 1);
            candidatesByCourse.get(cid)!.push(sid);
          }
        }

        // Construir "course-sections" dividiendo cursos que superan el mayor salón (cap) y limitando por maxSectionsPerCoursePerSlot
        type CourseSection = { course_id: string; expected: number };
        const sections: CourseSection[] = [];
        for (const [cid, dem] of demandByCourse.entries()) {
          let demand = dem || 0;
          if (demand <= 0) continue;
          const maxSec = Math.max(1, maxSectionsPerCoursePerSlot);
          const needed = largestRoomCap > 0 ? Math.ceil(demand / largestRoomCap) : 1;
          const secCount = Math.min(maxSec, Math.max(1, needed));
          // distribuir demanda (heurístico) para ordenar después
          const base = Math.floor(demand / secCount);
          const rem = demand % secCount;
          for (let i = 0; i < secCount; i++) {
            sections.push({ course_id: cid, expected: base + (i < rem ? 1 : 0) });
          }
        }

        // Ordenar secciones por expected desc y salas por capacidad desc
        sections.sort((a, b) => b.expected - a.expected);
        const roomsThisSlot = roomsByCapacity.slice(); // copia

        // Asignación greedy sección→sala
        while (sections.length > 0 && roomsThisSlot.length > 0) {
          // tomar la sección más demandada y la sala más grande
          const sec = sections.shift()!;
          const room = roomsThisSlot.shift()!;
          const cap = room.capacity;

          // Si min_fill_rate exige cierto mínimo, saltar si no lo cumple
          if (minFillRate !== null && cap > 0) {
            const ratio = (sec.expected || 0) / cap;
            if (ratio < minFillRate) {
              // no abrimos este grupo; probamos con otra sección/sala (la sala vuelve al pool)
              roomsThisSlot.unshift(room);
              continue;
            }
          }

          // Seleccionar alumnos válidos para esta sección
          // Prioridad: menos opciones primero (eligibleCount asc), y que mantengan contigüidad si aplica
          const cand = (candidatesByCourse.get(sec.course_id) || [])
            .filter((sid) => {
              if ((assignedCount.get(sid) || 0) >= maxCoursesPerStudent) return false;
              if (!canTakeSlot(sid, shift, s.day, s.index, allowBreaks)) return false;
              // no repetir curso (ya verificado al armar candidates, pero doble chequeo es barato)
              if ((assignedCourses.get(sid)?.has(sec.course_id)) === true) return false;
              return true;
            })
            .sort((a, b) => (eligibleCountByStudent.get(a)! - eligibleCountByStudent.get(b)!));

          const take = Math.min(cap, cand.length);
          if (take <= 0) {
            // si no hay candidatos, no abrimos grupo (para no dejar "sala vacía")
            continue;
          }

          // Crear grupo programado
          const key = `${sec.course_id}|${shift}`;
          const nextIdx = (groupIndexMap.get(key) || 0) + 1;
          groupIndexMap.set(key, nextIdx);

          const groupId = `G-${sec.course_id}-${shift}-${s.day}-${s.index}-${nextIdx}`;
          const selected = cand.slice(0, take);

          scheduledGroups.push({
            ephemeral_id: groupId,
            course_id: sec.course_id,
            shift,
            group_index: nextIdx,
            room_id: room.id,
            room_code: room.code,
            capacity: cap,
            meeting: { day: s.day, start: s.start, end: s.end, shift, slot_index: s.index },
            assigned_students: selected,
          });

          // Actualizar estado global
          for (const sid of selected) {
            assignedCount.set(sid, (assignedCount.get(sid) || 0) + 1);
            if (!assignedCourses.has(sid)) assignedCourses.set(sid, new Set());
            assignedCourses.get(sid)!.add(sec.course_id);

            const k = `${sid}|${shift}`;
            if (!assignedSlotsByDay.has(k)) assignedSlotsByDay.set(k, new Map());
            const map = assignedSlotsByDay.get(k)!;
            if (!map.has(s.day)) map.set(s.day, new Set());
            map.get(s.day)!.add(s.index);

            // Quitar al alumno del pool de ese curso en este slot
            const list = candidatesByCourse.get(sec.course_id)!;
            const pos = list.indexOf(sid);
            if (pos >= 0) list.splice(pos, 1);
          }

          // Recalcular demanda restante para ese curso (opcional en este simple loop). Aquí basta continuar a la siguiente sección/sala.
        }
      }
    }

    // ========= 6) SALIDA =========
    const groupsUsage = scheduledGroups.map((g) => {
      const used = g.assigned_students.length;
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

    const studentsOverview = (students ?? []).map((s: any) => ({
      id: s.id as string,
      name: (s.name ?? null) as string | null,
      shift: (s.shift ?? "matutino") as Shift,
      assigned: assignedCount.get(s.id) || 0,
    }));

    const assignmentsDetailed = scheduledGroups.flatMap((g) =>
      g.assigned_students.map((sid) => ({
        student_id: sid,
        course_code: courseById.get(g.course_id)?.code || "",
        turno: g.shift,
        room: g.room_code,
        day_of_week: g.meeting.day,
        slot_index: g.meeting.slot_index,
        start_time: minToHHMM(g.meeting.start),
        end_time: minToHHMM(g.meeting.end),
      })),
    );

    return NextResponse.json({
      ok: true,
      params: {
        max_sections_per_course_per_slot: maxSectionsPerCoursePerSlot,
        min_fill_rate: minFillRate,
      },
      summary: {
        total_rooms: roomsArr.length,
        total_courses: coursesArr.length,
        total_groups: scheduledGroups.length,
      },
      scheduled_groups: groupsUsage,            // pestaña "Materias" y ocupación por salón
      students_overview: studentsOverview,      // pestaña "Alumnos"
      assignments_detailed: assignmentsDetailed,// pestaña "Horarios"
      students_catalog: (students ?? []).map((s: any) => ({
        id: s.id as string,
        name: (s.name ?? null) as string | null,
        shift: (s.shift ?? "matutino") as Shift,
      })),
      rooms_catalog: roomsArr.map((r) => ({ id: r.id, code: r.code, capacity: r.capacity })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
