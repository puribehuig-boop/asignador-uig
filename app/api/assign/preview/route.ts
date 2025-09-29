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

    // límites por alumno
    const maxCoursesPerStudent = Number(S.max_courses_per_student ?? 5);

    // Parámetros de llenado de grupos
    const maxSectionsPerCoursePerSlot: number = Number(S.max_sections_per_course_per_slot ?? 2);
    const overProvisionFactor: number = Number(S.over_provision_factor ?? 1.15); // 15% por defecto
    const assignmentPasses: number = Math.max(1, Number(S.assignment_passes ?? 6));
    // Umbral opcional (0..1) para abrir grupos: evita grupos “flacos” en salas grandes
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

    // ========= 3) DEMANDA y TARGET por turno =========
    const demandByCourseShift = new Map<string, Record<Shift, number>>();
    for (const c of coursesArr) {
      const per: Record<Shift, number> = { matutino: 0, vespertino: 0, sabatino: 0, dominical: 0 };
      for (const sid of eligByCourse.get(c.id) ?? []) {
        const sh = (studentShift.get(sid) || "matutino") as Shift;
        per[sh] += 1;
      }
      demandByCourseShift.set(c.id, per);
    }

    const targetCapacityByCourseShift = new Map<string, Record<Shift, number>>();
    const scheduledCapacityByCourseShift = new Map<string, Record<Shift, number>>();
    for (const [cid, per] of demandByCourseShift.entries()) {
      const target: Record<Shift, number> = { matutino: 0, vespertino: 0, sabatino: 0, dominical: 0 };
      const sched: Record<Shift, number>  = { matutino: 0, vespertino: 0, sabatino: 0, dominical: 0 };
      for (const sh of SHIFTS) {
        const dem = per[sh] || 0;
        target[sh] = Math.ceil(dem * overProvisionFactor);
      }
      targetCapacityByCourseShift.set(cid, target);
      scheduledCapacityByCourseShift.set(cid, sched);
    }

    // ========= 3b) SLOTS y SALAS =========
    const roomsByCapacity = roomsArr.slice().sort((a, b) => b.capacity - a.capacity);
    const groupIndexMap = new Map<string, number>(); // `${cid}|${shift}` -> consecutive idx within (course,shift)

    type ScheduledGroup = {
      ephemeral_id: string;
      course_id: string;
      shift: Shift;
      group_index: number;
      room_id: string;
      room_code: string;
      capacity: number;
      meeting: { day: number; start: number; end: number; shift: Shift; slot_index: number };
    };
    const scheduledGroups: ScheduledGroup[] = [];

    // Generación de slots por turno a partir de settings
    const timeSlotsByShift: Record<Shift, Array<{ day: number; start: number; end: number; shift: Shift; index: number }>> = {
      matutino: [],
      vespertino: [],
      sabatino: [],
      dominical: [],
    };
    for (const sh of SHIFTS) {
      const start = startByShift[sh];
      const dur   = durationByShift[sh];
      const slots = slotsPerDayByShift[sh];
      let idx = 0;
      for (const day of SHIFT_DAYS[sh]) {
        for (let k = 0; k < slots; k++) {
          const s = start + k * dur;
          timeSlotsByShift[sh].push({ day, start: s, end: s + dur, shift: sh, index: idx++ });
        }
      }
    }

    // ========= 3c) PROGRAMACIÓN DE GRUPOS (best-fit sala↔curso) =========
    for (const shift of SHIFTS) {
      const hasAnyDemand = Array.from(demandByCourseShift.values()).some(per => (per[shift] || 0) > 0);
      if (!hasAnyDemand) continue;

      const slots = timeSlotsByShift[shift].slice().sort((a, b) => a.day - b.day || a.start - b.start);

      for (const s of slots) {
        const usedCountThisSlot = new Map<string, number>(); // curso -> secciones en este slot

        // Por sala (cap desc) elige el curso que mejor calce (fit) su gap a la capacidad
        for (const room of roomsByCapacity) {
          let bestCid: string | null = null;
          let bestScore = -Infinity;
          let bestFit = 0;

          for (const [cid, per] of demandByCourseShift.entries()) {
            const dem = per[shift] || 0;
            if (dem <= 0) continue;

            const used = usedCountThisSlot.get(cid) || 0;
            if (used >= maxSectionsPerCoursePerSlot) continue;

            const target = targetCapacityByCourseShift.get(cid)![shift] || 0;
            const sched  = scheduledCapacityByCourseShift.get(cid)![shift] || 0;
            const gap    = Math.max(0, target - sched);
            if (gap <= 0) continue;

            const fit  = Math.min(room.capacity, gap);
            const over = Math.max(0, room.capacity - gap);
            const score = fit - 0.25 * over; // α penaliza sobre-dimensionar

            // Si definiste min_fill_rate, no abras grupos con “fit/cap” por debajo
            if (minFillRate !== null) {
              const ratio = room.capacity > 0 ? fit / room.capacity : 0;
              if (ratio < minFillRate) continue;
            }

            if (score > bestScore) {
              bestScore = score;
              bestCid   = cid;
              bestFit   = fit;
            }
          }

          if (!bestCid || bestScore <= 0 || bestFit <= 0) continue;

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

          usedCountThisSlot.set(bestCid, (usedCountThisSlot.get(bestCid) || 0) + 1);

          // acumula capacidad programada por (curso, turno)
          const sc = scheduledCapacityByCourseShift.get(bestCid)!;
          sc[shift] = (sc[shift] || 0) + room.capacity;
          scheduledCapacityByCourseShift.set(bestCid, sc);
        }
      }
    }

    // ========= 4) ASIGNACIÓN CON RESTRICCIONES POR ALUMNO (multi-pasada) =========
    // Índice de grupos por (shift|day|start)
    const groupsByKey = new Map<string, ScheduledGroup[]>();
    for (const g of scheduledGroups) {
      const key = `${g.shift}|${g.meeting.day}|${g.meeting.start}`;
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      groupsByKey.get(key)!.push(g);
    }

    // Capacidad remanente por grupo
    const remCap = new Map<string, number>();
    for (const g of scheduledGroups) remCap.set(g.ephemeral_id, g.capacity);

    // Estado acumulado para respetar restricciones globales:
    // - total por alumno <= maxCoursesPerStudent
    // - no repetir curso por alumno
    // - no asignar dos clases al mismo tiempo
    // - “sin descansos” (contiguidad) si allow_breaks=false
    const assignedCount = new Map<string, number>();                 // alumno -> total asignado
    const assignedCourses = new Map<string, Set<string>>();          // alumno -> set(curso_id)
    const assignedSlotsByDay = new Map<string, Map<number, Set<number>>>(); // key alumno|turno -> (day -> set(slot_index))

    // Utilidades flujo (Dinic)
    type Edge = { to: number; rev: number; cap: number };
    function makeGraph(n: number) { return Array.from({ length: n }, () => [] as Edge[]); }
    function addEdge(g: Edge[][], u: number, v: number, cap: number) {
      const a: Edge = { to: v, rev: g[v].length, cap };
      const b: Edge = { to: u, rev: g[u].length, cap: 0 };
      g[u].push(a); g[v].push(b);
    }
    function bfs(g: Edge[][], s: number, t: number, level: number[]) {
      level.fill(-1); const q: number[] = []; level[s] = 0; q.push(s);
      while (q.length) {
        const u = q.shift()!;
        for (const e of g[u]) if (e.cap > 0 && level[e.to] < 0) { level[e.to] = level[u] + 1; q.push(e.to); }
      }
      return level[t] >= 0;
    }
    function dfs(g: Edge[][], u: number, t: number, f: number, level: number[], it: number[]): number {
      if (u === t) return f;
      for (let i = it[u]; i < g[u].length; i++, it[u] = i) {
        const e = g[u][i];
        if (e.cap > 0 && level[u] < level[e.to]) {
          const d = dfs(g, e.to, t, Math.min(f, e.cap), level, it);
          if (d > 0) { e.cap -= d; g[e.to][e.rev].cap += d; return d; }
        }
      }
      return 0;
    }
    function dinic(g: Edge[][], s: number, t: number) {
      let flow = 0; const n = g.length; const level = new Array(n).fill(-1); const it = new Array(n).fill(0);
      while (bfs(g, s, t, level)) { it.fill(0); let f: number; while ((f = dfs(g, s, t, Infinity, level, it)) > 0) flow += f; }
      return flow;
    }

    // Orden de alumnos por “difíciles de asignar” (menos elegibles primero)
    const studentsByShift: Record<Shift, string[]> = { matutino: [], vespertino: [], sabatino: [], dominical: [] };
    for (const sid of Array.from(eligByStudent.keys())) {
      const sh = (studentShift.get(sid) || "matutino") as Shift;
      studentsByShift[sh].push(sid);
    }
    for (const sh of SHIFTS) {
      studentsByShift[sh].sort((a, b) => (eligByStudent.get(a)?.size || 0) - (eligByStudent.get(b)?.size || 0));
    }

    const proposed: Array<{
      student_id: string; course_id: string; group_ephemeral_id: string;
      shift: Shift; day: number; start: number; end: number;
    }> = [];

    const slotsAsc: Array<{ shift: Shift; day: number; start: number; index: number }> = [];
    for (const sh of SHIFTS) {
      for (const s of timeSlotsByShift[sh]) slotsAsc.push({ shift: sh, day: s.day, start: s.start, index: s.index });
    }
    slotsAsc.sort(
      (a, b) =>
        (a.shift === b.shift ? 0 : SHIFTS.indexOf(a.shift) - SHIFTS.indexOf(b.shift)) ||
        a.day - b.day ||
        a.start - b.start,
    );
    const slotsDesc = slotsAsc.slice().reverse();

    const runPass = (orderedSlots: typeof slotsAsc) => {
      for (const slot of orderedSlots) {
        const key = `${slot.shift}|${slot.day}|${slot.start}`;
        const groupsHere = (groupsByKey.get(key) || []).filter(g => (remCap.get(g.ephemeral_id) || 0) > 0);
        if (groupsHere.length === 0) continue;

        const allowBreaks = allowBreaksByShift[slot.shift];
        const studentIds  = studentsByShift[slot.shift];

        // Construir grafo para ESTE slot —> restricción “una clase máx por alumno en este horario”
        // SRC -> alumno (cap = min(1, rem_global))
        // alumno -> grupo (si elegible y sin repetir curso, y cumpliendo “breaks”)
        // grupo -> SNK (cap = cupo remanente)
        const studentIndex = new Map<string, number>();
        const groupIndex   = new Map<string, number>();

        let N = 2; // SRC=0, SNK=N-1 (definimos al final)
        for (const sid of studentIds) {
          const assigned = assignedCount.get(sid) || 0;
          if (assigned >= maxCoursesPerStudent) continue; // no más clases que su límite

          // si ya tiene algo en este mismo slot (por pasadas previas), no lo metemos
          const dayMap = assignedSlotsByDay.get(`${sid}|${slot.shift}`);
          if (dayMap && dayMap.get(slot.day)?.has(slot.index)) continue;

          studentIndex.set(sid, N++);
        }
        for (const gr of groupsHere) groupIndex.set(gr.ephemeral_id, N++);

        const SRC = 0, SNK = N;
        const g = makeGraph(SNK + 1);

        // S -> alumnos (capacidad 1 por slot para prohibir 2 clases al mismo tiempo)
        for (const [sid, idx] of studentIndex) {
          const remaining = Math.max(0, maxCoursesPerStudent - (assignedCount.get(sid) || 0));
          if (remaining <= 0) continue;
          addEdge(g, SRC, idx, 1); // *** CLAVE: 1 por slot ***
        }

        // grupos -> T
        for (const [gid, gi] of groupIndex) {
          addEdge(g, gi, SNK, Math.max(0, (remCap.get(gid) || 0)));
        }

        // alumnos -> grupos (elegible + sin curso repetido + regla de “breaks” si aplica)
        for (const [sid, li] of studentIndex) {
          const eligs = eligByStudent.get(sid) || new Set<string>();
          const already = assignedCourses.get(sid) || new Set<string>();
          const dayMap  = assignedSlotsByDay.get(`${sid}|${slot.shift}`) || new Map<number, Set<number>>();

          for (const gr of groupsHere) {
            const courseId = gr.course_id;

            // Debe ser elegible y no repetir curso
            if (!eligs.has(courseId)) continue;
            if (already.has(courseId)) continue;

            // “Sin descansos” = contiguidad por día (si allowBreaks=false)
            if (!allowBreaks) {
              const set = dayMap.get(slot.day) || new Set<number>();
              if (set.size > 0) {
                const minIdx = Math.min(...Array.from(set.values()));
                const maxIdx = Math.max(...Array.from(set.values()));
                const isAdjacent = slot.index === minIdx - 1 || slot.index === maxIdx + 1 || set.has(slot.index);
                if (!isAdjacent) continue; // al forzar contigüidad, evitamos huecos
              }
            }

            const gi = groupIndex.get(gr.ephemeral_id)!;
            addEdge(g, li, gi, 1);
          }
        }

        // Max-flow en este slot
        dinic(g, SRC, SNK);

        // Recuperar matches (alumno->grupo saturados)
        const newlyAssigned: Array<{ sid: string; gid: string }> = [];
        for (const [sid, li] of studentIndex) {
          for (const e of g[li]) {
            const gi = e.to;
            // arista usada si el residual en la inversa aumentó (cap>0 en back-edge)
            if (gi === SRC || gi === SNK) continue;
            const back = g[gi][e.rev];
            if (back.cap <= 0) continue; // no se usó
            // localizar grupo por índice
            for (const [gid, idx] of groupIndex) {
              if (idx === gi) newlyAssigned.push({ sid, gid });
            }
          }
        }

        // Aplicar asignaciones y actualizar estados globales
        for (const a of newlyAssigned) {
          const ginfo = groupsHere.find(x => x.ephemeral_id === a.gid)!;
          const sid   = a.sid;

          proposed.push({
            student_id: sid,
            course_id: ginfo.course_id,
            group_ephemeral_id: ginfo.ephemeral_id,
            shift: ginfo.shift,
            day: ginfo.meeting.day,
            start: ginfo.meeting.start,
            end: ginfo.meeting.end,
          });

          // bajar cupo del grupo
          remCap.set(ginfo.ephemeral_id, Math.max(0, (remCap.get(ginfo.ephemeral_id) || 0) - 1));

          // actualizar totales alumno
          assignedCount.set(sid, (assignedCount.get(sid) || 0) + 1);
          if (!assignedCourses.has(sid)) assignedCourses.set(sid, new Set());
          assignedCourses.get(sid)!.add(ginfo.course_id);

          const k = `${sid}|${slot.shift}`;
          if (!assignedSlotsByDay.has(k)) assignedSlotsByDay.set(k, new Map());
          const map = assignedSlotsByDay.get(k)!;
          if (!map.has(slot.day)) map.set(slot.day, new Set());
          map.get(slot.day)!.add(slot.index);
        }
      }
    };

    // Varias pasadas (llenado más robusto sin violar restricciones)
    for (let k = 0; k < assignmentPasses; k++) {
      if (k % 2 === 0) runPass(slotsAsc);
      else runPass(slotsDesc);
    }

    // ========= 5) SALIDA =========
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

    // Resumen de alumnos
    const studentsOverview = (students ?? []).map((s: any) => ({
      id: s.id as string,
      name: (s.name ?? null) as string | null,
      shift: (s.shift ?? "matutino") as Shift,
      assigned: assignedCount.get(s.id) || 0,
    }));

    const assignmentsDetailed = proposed.map((a) => {
      const g = scheduledGroups.find((x) => x.ephemeral_id === a.group_ephemeral_id)!;
      return {
        student_id: a.student_id,
        course_code: courseById.get(a.course_id)?.code || "",
        turno: g.shift,
        room: g.room_code,
        day_of_week: g.meeting.day,
        slot_index: g.meeting.slot_index,
        start_time: minToHHMM(g.meeting.start),
        end_time: minToHHMM(g.meeting.end),
      };
    });

    // Unassigned aprox por curso (demanda vs capacidad programada), útil para afinar settings
    const unassignedByCourse: Array<{ course_code: string; turno: Shift; count: number }> = [];
    for (const [cid, per] of demandByCourseShift.entries()) {
      for (const sh of SHIFTS) {
        const demand = per[sh] || 0;
        const sched  = scheduledCapacityByCourseShift.get(cid)![sh] || 0;
        const gap    = Math.max(0, demand - sched);
        if (gap > 0) {
          unassignedByCourse.push({
            course_code: courseById.get(cid)?.code || "",
            turno: sh,
            count: gap,
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      params: {
        max_sections_per_course_per_slot: maxSectionsPerCoursePerSlot,
        over_provision_factor: overProvisionFactor,
        assignment_passes: assignmentPasses,
        min_fill_rate: minFillRate,
      },
      summary: {
        total_rooms: roomsArr.length,
        total_courses: coursesArr.length,
        total_groups: scheduledGroups.length,
      },
      unassigned_by_course: unassignedByCourse,
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
