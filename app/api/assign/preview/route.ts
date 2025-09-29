// app/api/assign/preview/route.ts
// Next.js App Router — endpoint "preview" para generar una asignación tentativa.
//
// ✅ Incluye "best-fit" sala↔curso para subir ocupación.
// ✅ Soporta parámetro opcional MIN_FILL_RATE (0–1) para no abrir grupos "delgaditos".
// ✅ Mantiene estructura de respuesta con métricas útiles.
//
// Espera un POST con JSON similar a:
// {
//   "rooms": [{ id, code, capacity }],
//   "courses": [{ id, code }],
//   "slots": [{ day, start, end, shift, index }],
//   "demand_by_course_shift": { [courseId]: { [shift]: number } },
//   "settings": {
//      "max_sections_per_course_per_slot": 2,
//      "over_provision_factor": 1.15,
//      "MIN_FILL_RATE": 0.4
//   }
// }
//
// Notas:
// - Si no envías demand_by_course_shift, intenta leerla de courses[i].demand_by_shift.
// - Si envías "shifts", se ignora; los "shifts" se infieren de slots.
//
// Autor: GPT

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Shift = string;

type Room = {
  id: string;
  code: string;
  capacity: number;
};

type Course = {
  id: string;
  code?: string;
  // opcional, usado si no llega demand_by_course_shift a nivel raíz
  demand_by_shift?: Record<Shift, number>;
};

type Slot = {
  day: string;        // "Mon" | "Tue" | ...
  start: string;      // "07:00"
  end: string;        // "09:00"
  shift: Shift;       // "MORNING" | "AFTERNOON" | "EVENING" | ...
  index: number;      // entero por cada día (0..N)
};

type Settings = {
  max_sections_per_course_per_slot?: number;
  over_provision_factor?: number;
  MIN_FILL_RATE?: number | null;
};

type ScheduledGroup = {
  ephemeral_id: string;
  course_id: string;
  shift: Shift;
  group_index: number; // contador por (course, shift) dentro del día/slot
  room_id: string;
  room_code: string;
  capacity: number;
  meeting: {
    day: string;
    start: string;
    end: string;
    shift: Shift;
    slot_index: number;
  };
};

type PreviewResponse = {
  ok: true;
  params: {
    max_sections_per_course_per_slot: number;
    over_provision_factor: number;
    MIN_FILL_RATE: number | null;
  };
  scheduled_groups: ScheduledGroup[];
  metrics: {
    seats_scheduled_total: number;
    courses: Array<{
      course_id: string;
      shift: Shift;
      demand: number;
      target_capacity: number;
      scheduled_capacity: number;
      gap_remaining: number;
    }>;
    occupancy_by_group: Array<{
      group_id: string;
      capacity: number;
      expected_fill_lower_bound: number; // basado en gap restante cuando se creó (aprox)
    }>;
    summary_by_shift: Array<{
      shift: Shift;
      demand_total: number;
      target_total: number;
      scheduled_total: number;
      gap_total: number;
    }>;
  };
  // Espacio para integrar tu asignación por alumno (max-flow) si la usas después
  assignments_detailed?: any[];
};

function toMap<T>(arr: T[], key: (x: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of arr) m.set(key(x), x);
  return m;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const rooms: Room[] = (body.rooms ?? []).map((r: any) => ({
      id: String(r.id),
      code: String(r.code ?? r.id),
      capacity: Number(r.capacity ?? 0),
    }));

    const courses: Course[] = (body.courses ?? []).map((c: any) => ({
      id: String(c.id),
      code: c.code ? String(c.code) : undefined,
      demand_by_shift: c.demand_by_shift ?? undefined,
    }));

    const slots: Slot[] = (body.slots ?? []).map((s: any) => ({
      day: String(s.day),
      start: String(s.start),
      end: String(s.end),
      shift: String(s.shift),
      index: Number(s.index ?? 0),
    }));

    const settingsIn: Settings = body.settings ?? {};
    const max_sections_per_course_per_slot =
      Number(settingsIn.max_sections_per_course_per_slot ?? 2);
    const over_provision_factor = Number(settingsIn.over_provision_factor ?? 1.15);
    const MIN_FILL_RATE: number | null =
      settingsIn.MIN_FILL_RATE === 0
        ? 0
        : settingsIn.MIN_FILL_RATE
        ? Math.max(0, Math.min(1, Number(settingsIn.MIN_FILL_RATE)))
        : null;

    // 1) Preparar demanda por (course, shift)
    const demandByCourseShift = new Map<string, Record<Shift, number>>();
    if (body.demand_by_course_shift) {
      const src = body.demand_by_course_shift as Record<string, Record<Shift, number>>;
      for (const cid of Object.keys(src)) {
        demandByCourseShift.set(cid, { ...src[cid] });
      }
    } else {
      for (const c of courses) {
        if (c.demand_by_shift) {
          demandByCourseShift.set(c.id, { ...c.demand_by_shift });
        } else {
          demandByCourseShift.set(c.id, {} as Record<Shift, number>);
        }
      }
    }

    // Inferir catálogo de shifts existentes a partir de slots y/o demanda
    const allShifts = new Set<Shift>();
    for (const s of slots) allShifts.add(s.shift);
    for (const per of demandByCourseShift.values()) {
      Object.keys(per).forEach((sh) => allShifts.add(sh));
    }

    // 2) Target por (course, shift) con sobre-provisión
    const targetCapacityByCourseShift = new Map<string, Record<Shift, number>>();
    for (const [cid, per] of demandByCourseShift.entries()) {
      const rec: Record<Shift, number> = {} as any;
      for (const sh of allShifts) {
        const dem = Number(per[sh] ?? 0);
        rec[sh] = Math.ceil(dem * over_provision_factor);
      }
      targetCapacityByCourseShift.set(cid, rec);
    }

    // 3) Programación de grupos (best-fit)
    //    Iteramos por día+slot; para cada slot ordenamos salas por capacidad DESC.
    const scheduledGroups: ScheduledGroup[] = [];
    const scheduledCapacityByCourseShift = new Map<string, Record<Shift, number>>();
    const groupIndexMap = new Map<string, number>(); // key: `${courseId}|${shift}|${day}|${slot_index}`

    // Preinicializar acumuladores
    for (const [cid] of demandByCourseShift.entries()) {
      const rec: Record<Shift, number> = {} as any;
      for (const sh of allShifts) rec[sh] = 0;
      scheduledCapacityByCourseShift.set(cid, rec);
    }

    const roomsByCapacity = [...rooms].sort((a, b) => b.capacity - a.capacity);

    // Agrupar slots por (day, index, shift) para garantizar consistencia
    const slotsKey = (s: Slot) => `${s.day}|${s.index}|${s.shift}`;
    const slotsMap = new Map<string, Slot[]>();
    for (const s of slots) {
      const k = slotsKey(s);
      if (!slotsMap.has(k)) slotsMap.set(k, []);
      slotsMap.get(k)!.push(s);
    }
    // Para nuestra lógica basta un slot por clave; si en tu modelo hay multi-rangos por clave, toma el primero
    const canonicalSlots: Slot[] = [];
    for (const [, arr] of slotsMap) canonicalSlots.push(arr[0]);

    // Recorremos cada slot
    for (const s of canonicalSlots) {
      const shift = s.shift as Shift;
      // Límite de secciones por curso en este slot
      const usedCountThisSlot = new Map<string, number>(); // courseId -> count en este slot

      for (const room of roomsByCapacity) {
        // Buscar el curso que mejor "calce" con la sala actual (best-fit).
        let bestCid: string | null = null;
        let bestScore = -Infinity;
        let bestFit = 0;

        for (const [cid, per] of demandByCourseShift.entries()) {
          const dem = Number(per[shift] ?? 0);
          if (dem <= 0) continue;

          const used = usedCountThisSlot.get(cid) ?? 0;
          if (used >= max_sections_per_course_per_slot) continue;

          const target = Number(targetCapacityByCourseShift.get(cid)?.[shift] ?? 0);
          const sched = Number(scheduledCapacityByCourseShift.get(cid)?.[shift] ?? 0);
          const gap = Math.max(0, target - sched);
          if (gap <= 0) continue;

          // Best-fit score
          const fit = Math.min(room.capacity, gap);
          const over = Math.max(0, room.capacity - gap);
          const score = fit - 0.25 * over; // α=0.25 (ajustable)

          // Filtro por MIN_FILL_RATE opcional
          if (MIN_FILL_RATE !== null) {
            const ratio = room.capacity > 0 ? fit / room.capacity : 0;
            if (ratio < MIN_FILL_RATE) continue;
          }

          if (score > bestScore) {
            bestScore = score;
            bestCid = cid;
            bestFit = fit;
          }
        }

        // Si ninguna materia calza razonablemente, saltamos esta sala en este slot.
        if (!bestCid || bestScore <= 0 || bestFit <= 0) {
          continue;
        }

        // Generar índice de grupo por (course, shift, day, slot)
        const gkey = `${bestCid}|${shift}|${s.day}|${s.index}`;
        const nextIdx = (groupIndexMap.get(gkey) ?? 0) + 1;
        groupIndexMap.set(gkey, nextIdx);

        const newGroup: ScheduledGroup = {
          ephemeral_id: `G-${bestCid}-${shift}-${s.day}-${s.index}-${nextIdx}`,
          course_id: bestCid,
          shift,
          group_index: nextIdx,
          room_id: room.id,
          room_code: room.code,
          capacity: room.capacity,
          meeting: {
            day: s.day,
            start: s.start,
            end: s.end,
            shift,
            slot_index: s.index,
          },
        };
        scheduledGroups.push(newGroup);

        // Actualizar contadores
        usedCountThisSlot.set(bestCid, (usedCountThisSlot.get(bestCid) ?? 0) + 1);
        const sc = scheduledCapacityByCourseShift.get(bestCid)!;
        sc[shift] = (sc[shift] ?? 0) + room.capacity;
        scheduledCapacityByCourseShift.set(bestCid, sc);
      }
    }

    // 4) Métricas y resumen
    const occupancy_by_group: PreviewResponse["metrics"]["occupancy_by_group"] = [];
    for (const g of scheduledGroups) {
      // Como lower bound de "expected fill", usamos el gap en el momento de crear
      // (Aquí no almacenamos ese instante; aproximamos con gap final truncado a [0, capacity])
      const target = Number(targetCapacityByCourseShift.get(g.course_id)?.[g.shift] ?? 0);
      const sched = Number(scheduledCapacityByCourseShift.get(g.course_id)?.[g.shift] ?? 0);
      const gapRemaining = Math.max(0, target - sched);
      const expectedFitLowerBound = Math.max(0, Math.min(g.capacity, g.capacity - gapRemaining)); // aproximación
      const ratio = g.capacity > 0 ? expectedFitLowerBound / g.capacity : 0;

      occupancy_by_group.push({
        group_id: g.ephemeral_id,
        capacity: g.capacity,
        expected_fill_lower_bound: Number(ratio.toFixed(3)),
      });
    }

    const perCourseMetrics: PreviewResponse["metrics"]["courses"] = [];
    const perShiftAgg = new Map<Shift, { demand_total: number; target_total: number; scheduled_total: number }>();
    for (const sh of allShifts) {
      perShiftAgg.set(sh, { demand_total: 0, target_total: 0, scheduled_total: 0 });
    }

    for (const [cid, per] of demandByCourseShift.entries()) {
      for (const sh of allShifts) {
        const demand = Number(per[sh] ?? 0);
        const target = Number(targetCapacityByCourseShift.get(cid)?.[sh] ?? 0);
        const sched = Number(scheduledCapacityByCourseShift.get(cid)?.[sh] ?? 0);
        const gap_remaining = Math.max(0, target - sched);

        perCourseMetrics.push({
          course_id: cid,
          shift: sh,
          demand,
          target_capacity: target,
          scheduled_capacity: sched,
          gap_remaining,
        });

        const agg = perShiftAgg.get(sh)!;
        agg.demand_total += demand;
        agg.target_total += target;
        agg.scheduled_total += sched;
        perShiftAgg.set(sh, agg);
      }
    }

    const summary_by_shift = Array.from(perShiftAgg.entries()).map(([shift, agg]) => ({
      shift,
      demand_total: agg.demand_total,
      target_total: agg.target_total,
      scheduled_total: agg.scheduled_total,
      gap_total: Math.max(0, agg.target_total - agg.scheduled_total),
    }));

    const seats_scheduled_total = scheduledGroups.reduce((acc, g) => acc + g.capacity, 0);

    const res: PreviewResponse = {
      ok: true,
      params: {
        max_sections_per_course_per_slot,
        over_provision_factor,
        MIN_FILL_RATE,
      },
      scheduled_groups: scheduledGroups,
      metrics: {
        seats_scheduled_total,
        courses: perCourseMetrics,
        occupancy_by_group,
        summary_by_shift,
      },
      assignments_detailed: [], // deja esto si más adelante agregas tu max-flow por alumno
    };

    return NextResponse.json(res, { status: 200 });
  } catch (err: any) {
    console.error("preview/route error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to generate preview",
        detail: err?.message ?? String(err),
      },
      { status: 400 }
    );
  }
}
