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

    // demanda por curso (total y por turno) + elegibilidades por alumno (SET para únicos)
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
    const remainingDemand = new Map<string, Record<Shift, number>>();
    for (const [cid, per] of demandByCourseShift.entries()) remainingDemand.set(cid, { ...per });

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

          if (!bestCid || bestDem <= 0) continue;

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

    // ========= 4) ASIGNACIÓN ALUMNO->GRUPO (máximo flujo por slot) =========
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

    const studentSchedule = new Map<string, Meeting[]>();             // agenda por alumno
    const studentLoad = new Map<string, number>();                    // materias asignadas por alumno
    const assignedCoursesByStudent = new Map<string, Set<string>>();  // no repetir materia
    const proposed: { student_id: string; course_id: string; ephemeral_group_id: string }[] = [];

    // alumnos por turno (orden: menos elegibles primero)
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

    // slots cronológicos globales
    const slotsChrono: Array<{ shift: Shift; day: number; start: number }> = [];
    for (const sh of SHIFTS) {
      for (const s of timeSlotsByShift[sh]) slotsChrono.push({ shift: sh, day: s.day, start: s.start });
    }
    slotsChrono.sort(
      (a, b) =>
        (a.shift === b.shift ? 0 : SHIFTS.indexOf(a.shift) - SHIFTS.indexOf(b.shift)) ||
        a.day - b.day ||
        a.start - b.start,
    );

    // Dinic (flujo máximo) -----------------------------------------------
    type Edge = { to: number; rev: number; cap: number };
    function makeGraph(n: number) {
      const g: Edge[][] = Array.from({ length: n }, () => []);
      function addEdge(u: number, v: number, cap: number) {
        const a: Edge = { to: v, rev: g[v].length, cap };
        const b: Edge = { to: u, rev: g[u].length, cap: 0 };
        g[u].push(a); g[v].push(b);
      }
      function bfs(s: number, t: number, level: number[]) {
        level.fill(-1); const q: number[] = [];
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
    // ---------------------------------------------------------------------

    for (const slot of slotsChrono) {
      const k = `${slot.shift}|${slot.day}|${slot.start}`;
      const groupsHere = (groupsByKey.get(k) || []).filter(g => (remCap.get(g.ephemeral_id) || 0) > 0);
      if (groupsHere.length === 0) continue;

      const allowBreaks = allowBreaksByShift[slot.shift];
      const studentIds = studentsByShift[slot.shift];

      // 1) Lista de alumnos candidatos para este slot (cumplen restricciones globales)
      const candStudents: string[] = [];
      const allowedLoadByStudent = new Map<string, number>();
      for (const sid of studentIds) {
        const eligSet = eligByStudent.get(sid) || new Set<string>();
        const allowedLoad = Math.min(maxCoursesPerStudent, eligSet.size);
        if ((studentLoad.get(sid) || 0) >= allowedLoad) continue;

        let sched = studentSchedule.get(sid) || [];
        // “sin descanso”: si ya tiene algo este día, sólo contiguo al bloque
        const daySched = sched.filter((s) => s.day === slot.day);
        const requireContiguous = !allowBreaks && daySched.length > 0;
        let minStart = Infinity, maxEnd = -Infinity;
        if (requireContiguous) {
          for (const s of daySched) { if (s.start < minStart) minStart = s.start; if (s.end > maxEnd) maxEnd = s.end; }
        }

        // Checar si *podría* tomar algo en este slot (independiente del curso)
        // (mismo horario prohibido con su propia agenda es irrelevante aquí porque es “este mismo slot”)
        if (requireContiguous) {
          const contiguous = (slot.start + durationByShift[slot.shift] === minStart) || (slot.start === maxEnd);
          if (!contiguous) continue;
        }
        allowedLoadByStudent.set(sid, allowedLoad);
        candStudents.push(sid);
      }
      if (candStudents.length === 0) continue;

      // 2) Armar red de flujo: source -> alumnos -> grupos -> sink
      //    (cap alumno = 1, cap grupo = capacidad restante)
      const N = candStudents.length;
      const M = groupsHere.length;
      const SRC = 0;
      const SNK = 1 + N + M;
      const { g, addEdge, maxflow } = makeGraph(SNK + 1);

      // mapear índices
      const studentIndex = new Map<string, number>(); // id -> 0..N-1
      candStudents.forEach((sid, i) => studentIndex.set(sid, i));
      const groupIndex = new Map<string, number>();   // ephemeral_id -> 0..M-1
      groupsHere.forEach((gr, j) => groupIndex.set(gr.ephemeral_id, j));

      // source -> alumnos
      for (let i = 0; i < N; i++) {
        addEdge(SRC, 1 + i, 1);
      }
      // grupos -> sink (con cap restante)
      for (let j = 0; j < M; j++) {
        const gr = groupsHere[j];
        const capRem = remCap.get(gr.ephemeral_id) || 0;
        if (capRem > 0) addEdge(1 + N + j, SNK, capRem);
      }

      // alumnos -> grupos (si elegible, no repetida, respeta “sin descanso” y no solapa agenda)
      for (const sid of candStudents) {
        const i = studentIndex.get(sid)!;
        const eligSet = eligByStudent.get(sid) || new Set<string>();
        const taken = assignedCoursesByStudent.get(sid) || new Set<string>();
        const sched = studentSchedule.get(sid) || [];

        for (const gr of groupsHere) {
          if (!eligSet.has(gr.course_id)) continue;
          if (taken.has(gr.course_id)) continue;

          // misma hora exacta prohibida (ya la checa “una por slot”, pero mantenemos)
          const sameHour = sched.some((s) => s.day === gr.meeting.day && s.start === gr.meeting.start);
          if (sameHour) continue;

          // no solape
          const hasOverlap = sched.some((s) => overlap(s, gr.meeting));
          if (hasOverlap) continue;

          // sin descanso si aplica (sólo contiguo al bloque del día)
          if (!allowBreaks) {
            const daySched = sched.filter((s) => s.day === gr.meeting.day);
            if (daySched.length > 0) {
              const minStart = Math.min(...daySched.map(s => s.start));
              const maxEnd   = Math.max(...daySched.map(s => s.end));
              const contiguous = (gr.meeting.end === minStart) || (gr.meeting.start === maxEnd);
              if (!contiguous) continue;
            }
          }

          const j = groupIndex.get(gr.ephemeral_id)!;
          addEdge(1 + i, 1 + N + j, 1);
        }
      }

      // 3) Correr flujo y leer emparejamientos usados (edges alumnos->grupos con cap agotada)
      maxflow(SRC, SNK);

      // Recorrer alumnos y ver sus edges hacia grupos: si cap==0 => se usó
      for (let i = 0; i < N; i++) {
        const sid = candStudents[i];
        const allowedLoad = allowedLoadByStudent.get(sid)!;
        if ((studentLoad.get(sid) || 0) >= allowedLoad) continue;

        for (const e of g[1 + i]) {
          // ¿apunta a un grupo?
          const node = e.to;
          const j = node - (1 + N);
          if (j < 0 || j >= M) continue;
          // si la arista estudiante->grupo quedó con cap 0, se envió flujo (asignación)
          if (e.cap === 0) {
            const gr = groupsHere[j];

            // seguridad: aún hay capacidad remanente contada? (el residual ya la consumió, pero mantenemos invariantes)
            const capRem = remCap.get(gr.ephemeral_id) || 0;
            if (capRem <= 0) continue;

            // registrar
            proposed.push({ student_id: sid, course_id: gr.course_id, ephemeral_group_id: gr.ephemeral_id });
            remCap.set(gr.ephemeral_id, capRem - 1);
            studentLoad.set(sid, (studentLoad.get(sid) || 0) + 1);

            const newSched = (studentSchedule.get(sid) || []).concat([gr.meeting]);
            studentSchedule.set(sid, newSched);

            if (!assignedCoursesByStudent.has(sid)) assignedCoursesByStudent.set(sid, new Set<string>());
            assignedCoursesByStudent.get(sid)!.add(gr.course_id);

            // “una por slot por alumno” se garantiza por cap=1 desde source->alumno
          }
        }
      }
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
      scheduled_groups: groupsUsage,            // para "Materias" y horarios por salón
      students_overview: studentsOverview,      // para "Alumnos"
      assignments_detailed: assignmentsDetailed,// para "Horarios" (alumno)
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
