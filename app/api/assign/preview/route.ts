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

// --- utilidades tiempo
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

// --- Dinic (flujo máximo)
type Edge = { to: number; rev: number; cap: number };
function makeGraph(n: number) {
  const g: Edge[][] = Array.from({ length: n }, () => []);
  function addEdge(u: number, v: number, cap: number) {
    const a: Edge = { to: v, rev: g[v].length, cap };
    const b: Edge = { to: u, rev: g[u].length, cap: 0 };
    g[u].push(a); g[v].push(b);
  }
  function bfs(s: number, t: number, level: number[]) {
    level.fill(-1);
    const q: number[] = [];
    level[s] = 0; q.push(s);
    while (q.length) {
      const u = q.shift()!;
      for (const e of g[u]) if (e.cap > 0 && level[e.to] < 0) {
        level[e.to] = level[u] + 1; q.push(e.to);
      }
    }
    return level[t] >= 0;
  }
  function dfs(u: number, t: number, f: number, level: number[], it: number[]): number {
    if (u === t) return f;
    for (let i = it[u]; i < g[u].length; i++, it[u] = i) {
      const e = g[u][i];
      if (e.cap > 0 && level[u] < level[e.to]) {
        const d = dfs(e.to, t, Math.min(f, e.cap), level, it);
        if (d > 0) {
          e.cap -= d;
          g[e.to][e.rev].cap += d;
          return d;
        }
      }
    }
    return 0;
  }
  function maxflow(s: number, t: number) {
    let flow = 0;
    const level = new Array(n).fill(-1);
    while (bfs(s, t, level)) {
      const it = new Array(n).fill(0);
      let f: number;
      while ((f = dfs(s, t, 1e9, level, it)) > 0) flow += f;
    }
    return flow;
  }
  return { g, addEdge, maxflow };
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

    // NUEVOS parámetros
    const maxSectionsPerCoursePerSlot: number = Number(S.max_sections_per_course_per_slot ?? 2);
    const overProvisionFactor: number = Number(S.over_provision_factor ?? 1.15); // 15% por defecto
    const assignmentPasses: number = Math.max(1, Number(S.assignment_passes ?? 6)); // pasadas asc/desc

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

    // demanda por curso (total y por turno) + elegibilidades por alumno (SET únicos)
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

    // ========= 3) PROGRAMACIÓN DE GRUPOS (demanda -> salas grandes por slot) =========
    // 3.1 Objetivos de capacidad por curso/turno (sobreoferta)
    const targetCapacityByCourseShift = new Map<string, Record<Shift, number>>();
    const scheduledCapacityByCourseShift = new Map<string, Record<Shift, number>>();
    for (const [cid, per] of demandByCourseShift.entries()) {
      const t: Record<Shift, number> = { matutino: 0, vespertino: 0, sabatino: 0, dominical: 0 };
      const s: Record<Shift, number> = { matutino: 0, vespertino: 0, sabatino: 0, dominical: 0 };
      for (const sh of SHIFTS) {
        const dem = per[sh] || 0;
        t[sh] = Math.ceil(dem * overProvisionFactor);
      }
      targetCapacityByCourseShift.set(cid, t);
      scheduledCapacityByCourseShift.set(cid, s);
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
      // slots cronológicos del turno
      const slots = timeSlotsByShift[shift].slice().sort((a, b) => a.day - b.day || a.start - b.start);

      for (const s of slots) {
        // limite de secciones por curso en este slot
        const usedCountThisSlot = new Map<string, number>(); // curso -> secciones en este slot

        // cursos candidatos con demanda > 0 en este turno
        const coursesWithDemand = Array.from(demandByCourseShift.entries())
          .filter(([cid, per]) => (per[shift] || 0) > 0)
          .map(([cid]) => cid);

        // ordenar salas por capacidad (desc)
        for (const room of roomsByCapacity) {
          // elegir curso con MAYOR "unmet" respecto al objetivo de sobreoferta
          let bestCid: string | null = null;
          let bestGap = -Infinity;

          for (const cid of coursesWithDemand) {
            // respetar límite de secciones por slot
            const used = usedCountThisSlot.get(cid) || 0;
            if (used >= maxSectionsPerCoursePerSlot) continue;

            const target = targetCapacityByCourseShift.get(cid)![shift] || 0;
            const sched = scheduledCapacityByCourseShift.get(cid)![shift] || 0;
            const gap = target - sched; // capacidad aún a programar

            if (gap > bestGap) {
              bestGap = gap;
              bestCid = cid;
            }
          }

          // Si ya alcanzamos todos los objetivos de sobreoferta, como fallback llena por pura demanda
          if (!bestCid || bestGap <= 0) {
            let fallbackCid: string | null = null;
            let fallbackDem = 0;
            for (const cid of coursesWithDemand) {
              const used = usedCountThisSlot.get(cid) || 0;
              if (used >= maxSectionsPerCoursePerSlot) continue;
              const dem = demandByCourseShift.get(cid)![shift] || 0;
              if (dem > fallbackDem) {
                fallbackDem = dem;
                fallbackCid = cid;
              }
            }
            if (!fallbackCid || fallbackDem <= 0) continue; // no hay nada que programar en este slot
            bestCid = fallbackCid;
          }

          // crea grupo (sección) para bestCid en este slot/sala
          const key = `${bestCid}|${shift}`;
          const nextIdx = (groupIndexMap.get(key) || 0) + 1;
          groupIndexMap.set(key, nextIdx);

          scheduledGroups.push({
            ephemeral_id: `G-${bestCid}-${shift}-${nextIdx}`,
            course_id: bestCid!,
            shift,
            group_index: nextIdx,
            room_id: room.id,
            room_code: room.code,
            capacity: room.capacity,
            meeting: { day: s.day, start: s.start, end: s.end, shift, slot_index: s.index },
          });

          usedCountThisSlot.set(bestCid!, (usedCountThisSlot.get(bestCid!) || 0) + 1);

          // acumula capacidad programada
          const sc = scheduledCapacityByCourseShift.get(bestCid!)!;
          sc[shift] = (sc[shift] || 0) + room.capacity;
          scheduledCapacityByCourseShift.set(bestCid!, sc);
        }
      }
    }

    // ========= 4) ASIGNACIÓN MULTI-PASADA CON FLUJO POR SLOT =========
    // Índice de grupos por (shift|day|start)
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

    const studentSchedule = new Map<string, Meeting[]>();             // agenda por alumno
    const studentLoad = new Map<string, number>();                    // materias asignadas por alumno
    const assignedCoursesByStudent = new Map<string, Set<string>>();  // no repetir materia
    const proposed: { student_id: string; course_id: string; ephemeral_group_id: string }[] = [];

    // alumnos por turno (menos elegibles primero)
    const studentsByShift: Record<Shift, string[]> = {
      matutino: [], vespertino: [], sabatino: [], dominical: [],
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

    // slots cronológicos (asc y desc)
    const slotsAsc: Array<{ shift: Shift; day: number; start: number }> = [];
    for (const sh of SHIFTS) for (const s of timeSlotsByShift[sh]) slotsAsc.push({ shift: sh, day: s.day, start: s.start });
    slotsAsc.sort((a, b) =>
      (a.shift === b.shift ? 0 : SHIFTS.indexOf(a.shift) - SHIFTS.indexOf(b.shift)) ||
      a.day - b.day || a.start - b.start
    );
    const slotsDesc = slotsAsc.slice().reverse();

    // función que corre una pasada (slots en un orden dado)
    const runPass = (orderedSlots: typeof slotsAsc) => {
      for (const slot of orderedSlots) {
        const k = `${slot.shift}|${slot.day}|${slot.start}`;
        const groupsHere = (groupsByKey.get(k) || []).filter(g => (remCap.get(g.ephemeral_id) || 0) > 0);
        if (groupsHere.length === 0) continue;

        const allowBreaks = allowBreaksByShift[slot.shift];
        const studentIds = studentsByShift[slot.shift];

        // 1) Candidatos de este slot (capacidad 1 por slot/alumno en la red)
        const candStudents: string[] = [];
        const allowedLoadByStudent = new Map<string, number>();
        for (const sid of studentIds) {
          const eligSet = eligByStudent.get(sid) || new Set<string>();
          const allowedLoad = Math.min(maxCoursesPerStudent, eligSet.size);
          if ((studentLoad.get(sid) || 0) >= allowedLoad) continue;

          const sched = studentSchedule.get(sid) || [];
          const daySched = sched.filter(s => s.day === slot.day);
          if (!allowBreaks && daySched.length > 0) {
            // Debe ser contiguo por delante o por detrás del bloque existente
            const minStart = Math.min(...daySched.map(s => s.start));
            const maxEnd   = Math.max(...daySched.map(s => s.end));
            const len = durationByShift[slot.shift];
            const contiguous = ((slot.start + len) === minStart) || (slot.start === maxEnd);
            if (!contiguous) continue;
          }
          allowedLoadByStudent.set(sid, allowedLoad);
          candStudents.push(sid);
        }
        if (candStudents.length === 0) continue;

        // 2) Grafo de flujo: SRC -> alumnos -> grupos -> SNK
        const N = candStudents.length;
        const M = groupsHere.length;
        const SRC = 0, SNK = 1 + N + M;
        const { g, addEdge, maxflow } = makeGraph(SNK + 1);

        const studentIndex = new Map<string, number>();
        candStudents.forEach((sid, i) => studentIndex.set(sid, i));
        const groupIndex = new Map<string, number>();
        groupsHere.forEach((gr, j) => groupIndex.set(gr.ephemeral_id, j));

        for (let i = 0; i < N; i++) addEdge(SRC, 1 + i, 1);
        for (let j = 0; j < M; j++) {
          const gr = groupsHere[j];
          const capRem = remCap.get(gr.ephemeral_id) || 0;
          if (capRem > 0) addEdge(1 + N + j, SNK, capRem);
        }

        // alumnos -> grupos (si elegible, no repetida, y no solapa su agenda)
        for (const sid of candStudents) {
          const i = studentIndex.get(sid)!;
          const eligSet = eligByStudent.get(sid) || new Set<string>();
          const taken = assignedCoursesByStudent.get(sid) || new Set<string>();
          const sched = studentSchedule.get(sid) || [];

          for (const gr of groupsHere) {
            if (!eligSet.has(gr.course_id)) continue;
            if (taken.has(gr.course_id)) continue;

            // misma hora exacta prohibida
            const sameHour = sched.some(s => s.day === gr.meeting.day && s.start === gr.meeting.start);
            if (sameHour) continue;

            // no solape
            const hasOverlap = sched.some(s => overlap(s, gr.meeting));
            if (hasOverlap) continue;

            const j = groupIndex.get(gr.ephemeral_id)!;
            addEdge(1 + i, 1 + N + j, 1);
          }
        }

        // 3) Flujo y aplicar asignaciones del residual (cap 0 en aristas alumno->grupo)
        maxflow(SRC, SNK);

        for (let i = 0; i < N; i++) {
          const sid = candStudents[i];
          const allowedLoad = allowedLoadByStudent.get(sid)!;
          if ((studentLoad.get(sid) || 0) >= allowedLoad) continue;

          for (const e of g[1 + i]) {
            const node = e.to;
            const j = node - (1 + N);
            if (j < 0 || j >= M) continue;
            if (e.cap === 0) { // se usó
              const gr = groupsHere[j];
              const capRem = remCap.get(gr.ephemeral_id) || 0;
              if (capRem <= 0) continue;

              proposed.push({ student_id: sid, course_id: gr.course_id, ephemeral_group_id: gr.ephemeral_id });
              remCap.set(gr.ephemeral_id, capRem - 1);
              studentLoad.set(sid, (studentLoad.get(sid) || 0) + 1);

              const newSched = (studentSchedule.get(sid) || []).concat([gr.meeting]);
              studentSchedule.set(sid, newSched);

              if (!assignedCoursesByStudent.has(sid)) assignedCoursesByStudent.set(sid, new Set<string>());
              assignedCoursesByStudent.get(sid)!.add(gr.course_id);
            }
          }
        }
      }
    };

    // Ejecuta varias pasadas asc/desc (mejora progresiva)
    for (let k = 0; k < assignmentPasses; k++) {
      if (k % 2 === 0) runPass(
        // asc
        (() => {
          const arr: Array<{ shift: Shift; day: number; start: number }> = [];
          for (const sh of SHIFTS) for (const s of timeSlotsByShift[sh]) arr.push({ shift: sh, day: s.day, start: s.start });
          arr.sort((a, b) =>
            (a.shift === b.shift ? 0 : SHIFTS.indexOf(a.shift) - SHIFTS.indexOf(b.shift)) ||
            a.day - b.day || a.start - b.start
          );
          return arr;
        })()
      );
      else runPass(
        // desc
        (() => {
          const arr: Array<{ shift: Shift; day: number; start: number }> = [];
          for (const sh of SHIFTS) for (const s of timeSlotsByShift[sh]) arr.push({ shift: sh, day: s.day, start: s.start });
          arr.sort((a, b) =>
            (a.shift === b.shift ? 0 : SHIFTS.indexOf(b.shift) - SHIFTS.indexOf(a.shift)) ||
            b.day - a.day || b.start - a.start
          );
          return arr;
        })()
      );
    }

    // ========= 5) SALIDAS =========
    const courseById = new Map(coursesArr.map((c) => [c.id, c]));

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

    // no asignados por curso (demanda - asignados)
    const assignedByCourse = new Map<string, number>();
    for (const a of proposed) assignedByCourse.set(a.course_id, (assignedByCourse.get(a.course_id) || 0) + 1);
    const unassignedByCourse = [];
    for (const c of coursesArr) {
      const dem = demandByCourseTotal.get(c.id) || 0;
      const got = assignedByCourse.get(c.id) || 0;
      const miss = dem - got;
      if (miss > 0) unassignedByCourse.push({ course_id: c.id, course_code: c.code || "", count: miss });
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
        max_sections_per_course_per_slot: maxSectionsPerCoursePerSlot,
        over_provision_factor: overProvisionFactor,
        assignment_passes: assignmentPasses,
      },
      summary: {
        students_total: studentsIdsSet.size,
        courses_with_demand: Array.from(demandByCourseTotal.keys()).length,
        scheduled_groups: scheduledGroups.length,
        proposed_assignments: proposed.length,
      },
      unassigned_by_course: unassignedByCourse,
      scheduled_groups: groupsUsage,            // Materias / salones
      students_overview: studentsOverview,      // Alumnos
      assignments_detailed: assignmentsDetailed,// Horarios por alumno
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
