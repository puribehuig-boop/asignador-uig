"use client";
import { useState } from "react";

type PreviewResp = {
  ok: boolean;
  params: {
    max_courses_per_student: number;
    target_group_size: number;
    slot_length_minutes: number;
    day_start: string;
    day_end: string;
    days_active: number[];
  };
  summary: {
    students_total: number;
    courses_with_demand: number;
    scheduled_groups: number;
    proposed_assignments: number;
  };
  unassigned_by_course: { course_id: string; course_code: string; count: number }[];
  scheduled_groups: {
    course_code: string;
    group_index: number;
    room: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
    capacity: number;
    used: number;
    fill_rate: number;
  }[];
  assignments_preview: { student_id: string; course_id: string; ephemeral_group_id: string }[];
};

export default function AssignPage() {
  const [maxCourses, setMaxCourses] = useState(5);
  const [targetGroupSize, setTargetGroupSize] = useState(30);
  const [slotLen, setSlotLen] = useState(90);
  const [dayStart, setDayStart] = useState("07:00");
  const [dayEnd, setDayEnd] = useState("21:00");
  const [days, setDays] = useState<number[]>([1,2,3,4,5]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PreviewResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleDay = (d: number) => {
    setDays((prev) => prev.includes(d) ? prev.filter(x => x !== d) : prev.concat([d]).sort());
  };

  const preview = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch("/api/assign/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          max_courses_per_student: maxCourses,
          target_group_size: targetGroupSize,
          slot_length_minutes: slotLen,
          day_start: dayStart,
          day_end: dayEnd,
          days_active: days,
        }),
      });
      const json = (await res.json()) as PreviewResp;
      if (!res.ok || !json.ok) throw new Error((json as any)?.error || "Error");
      setData(json);
    } catch (e: any) {
      setError(e?.message || "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 24, lineHeight: 1.4, maxWidth: 1100 }}>
      <h1>Asignación (Vista previa)</h1>
      <p>
        Esta vista previa <strong>genera grupos y horarios automáticamente</strong> usando tus salones y elegibilidades.
        No escribe en la base de datos.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, marginTop: 12 }}>
        <div>
          <label>Máx. materias por alumno</label>
          <input type="number" min={1} value={maxCourses} onChange={(e) => setMaxCourses(parseInt(e.target.value || "1", 10))} />
        </div>
        <div>
          <label>Tamaño objetivo de grupo</label>
          <input type="number" min={5} value={targetGroupSize} onChange={(e) => setTargetGroupSize(parseInt(e.target.value || "5", 10))} />
        </div>
        <div>
          <label>Duración de clase (min)</label>
          <input type="number" min={45} step={15} value={slotLen} onChange={(e) => setSlotLen(parseInt(e.target.value || "45", 10))} />
        </div>
        <div>
          <label>Inicio del día</label>
          <input type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} />
        </div>
        <div>
          <label>Fin del día</label>
          <input type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} />
        </div>
        <div>
          <label>Días activos</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[1,2,3,4,5,6].map((d) => (
              <label key={d} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={days.includes(d)} onChange={() => toggleDay(d)} /> {["L","M","X","J","V","S"][d-1]}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={preview} disabled={loading}>{loading ? "Calculando..." : "Generar vista previa"}</button>
        <a href="/setup/rooms" style={{ marginLeft: 12, textDecoration: "underline" }}>Gestionar salones</a>
      </div>

      {error && <p style={{ color: "crimson", marginTop: 12 }}>⚠️ {error}</p>}

      {data?.ok && (
        <>
          <div style={{ marginTop: 16, background: "#eefbf0", padding: 12 }}>
            <h3>Resumen</h3>
            <ul>
              <li>Alumnos (con elegibilidades): {data.summary.students_total}</li>
              <li>Cursos con demanda: {data.summary.courses_with_demand}</li>
              <li>Grupos programados: {data.summary.scheduled_groups}</li>
              <li>Asignaciones propuestas: {data.summary.proposed_assignments}</li>
            </ul>
          </div>

          <h3 style={{ marginTop: 24 }}>Grupos y horarios generados</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Curso</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Grupo</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Salón</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Día</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Inicio</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Fin</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Cap</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Usados</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>%</th>
              </tr>
            </thead>
            <tbody>
              {data.scheduled_groups.map((g, i) => (
                <tr key={i}>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.course_code}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>G{g.group_index}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.room}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{["","Lun","Mar","Mié","Jue","Vie","Sáb"][g.day_of_week]}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.start_time.slice(0,5)}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.end_time.slice(0,5)}</td>
                  <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{g.capacity}</td>
                  <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{g.used}</td>
                  <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{(g.fill_rate*100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 24 }}>No asignados por curso</h3>
          <ul>
            {data.unassigned_by_course?.map((u) => (
              <li key={u.course_id}>{u.course_code}: {u.count}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
