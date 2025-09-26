"use client";
import { useState, useEffect } from "react";

const dayName = (d: number) => ["","Lun","Mar","Mie","Jue","Vie","Sab","Dom"][d] || String(d);

export default function AssignPage() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [tab, setTab] = useState<"materias" | "alumnos" | "horarios">("materias");

  // Horarios: selección
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);

  const [roomQuery, setRoomQuery] = useState("");
  const [selectedRoomCode, setSelectedRoomCode] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/settings");
      const json = await res.json();
      if (json?.ok) setSettings(json.settings);
    })();
  }, []);

  const preview = async () => {
    setLoading(true); setError(null); setData(null);
    try {
      const res = await fetch("/api/assign/preview", { method: "POST", cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error || "Error");
      setData(json);
    } catch (e: any) { setError(e?.message || "Error desconocido"); }
    finally { setLoading(false); }
  };

  // Helpers para horarios
  const studentOptions = (data?.students_catalog || []).map((s: any) => ({
    id: s.id, label: s.name ? `${s.name} (${s.id})` : s.id
  }));
  const roomOptions = (data?.rooms_catalog || []).map((r: any) => ({ code: r.code }));

  const pickStudentFromQuery = () => {
    if (!data) return;
    const q = studentQuery.trim().toLowerCase();
    const byLabel = studentOptions.find((s: any) => s.label.toLowerCase() === q);
    if (byLabel) { setSelectedStudentId(byLabel.id); return; }
    const byId = studentOptions.find((s: any) => s.id.toLowerCase() === q);
    if (byId) { setSelectedStudentId(byId.id); return; }
    const contains = studentOptions.find((s: any) => s.label.toLowerCase().includes(q));
    setSelectedStudentId(contains ? contains.id : null);
  };

  const pickRoomFromQuery = () => {
    if (!data) return;
    const q = roomQuery.trim().toLowerCase();
    const exact = roomOptions.find((r: any) => r.code.toLowerCase() === q);
    if (exact) { setSelectedRoomCode(exact.code); return; }
    const contains = roomOptions.find((r: any) => r.code.toLowerCase().includes(q));
    setSelectedRoomCode(contains ? contains.code : null);
  };

  const studentSchedule = (() => {
    if (!data || !selectedStudentId) return [];
    return (data.assignments_detailed as any[])
      .filter(a => a.student_id === selectedStudentId)
      .slice()
      .sort((a,b) => (a.day_of_week - b.day_of_week) || (a.start_min - b.start_min));
  })();

  const roomSchedule = (() => {
    if (!data || !selectedRoomCode) return [];
    return (data.scheduled_groups as any[])
      .filter((g: any) => g.room === selectedRoomCode)
      .slice()
      .sort((a: any, b: any) => (a.day_of_week - b.day_of_week) || (a.start_min - b.start_min));
  })();

  const selectedStudentLabel = (() => {
    if (!data || !selectedStudentId) return "";
    const inCat = (data.students_catalog as any[]).find(s => s.id === selectedStudentId);
    if (!inCat) return selectedStudentId;
    return inCat.name ? `${inCat.name} (${inCat.id})` : inCat.id;
  })();

  return (
    <main style={{ padding: 24, lineHeight: 1.4, maxWidth: 1100 }}>
      <div style={{ marginBottom: 12 }}>
        <a href="/" style={{ textDecoration: "underline" }}>&larr; Regresar al inicio</a>
      </div>

      <h1>Asignacion · Vista previa</h1>
      <p>Usa <a href="/settings" style={{ textDecoration: "underline" }}>Ajustes (General)</a> para cambiar restricciones y salones.</p>

      {settings && (
        <div style={{ marginTop: 12, padding: 12, background: "#f7f9ff", borderRadius: 12 }}>
          <strong>Ajustes vigentes</strong>
          <ul style={{ margin: 0 }}>
            <li>Max. materias por alumno: {settings.max_courses_per_student}</li>
            <li>Matutino: {settings.start_matutino} · {settings.duration_matutino} min · {settings.slots_per_day_matutino} clases/dia · descansos {settings.allow_breaks_matutino ? "permitidos" : "no"}</li>
            <li>Vespertino: {settings.start_vespertino} · {settings.duration_vespertino} min · {settings.slots_per_day_vespertino} clases/dia · descansos {settings.allow_breaks_vespertino ? "permitidos" : "no"}</li>
            <li>Sabatino: {settings.start_sabatino} · {settings.duration_sabatino} min · {settings.slots_per_day_sabatino} clases/dia · descansos {settings.allow_breaks_sabatino ? "permitidos" : "no"}</li>
            <li>Dominical: {settings.start_dominical} · {settings.duration_dominical} min · {settings.slots_per_day_dominical} clases/dia · descansos {settings.allow_breaks_dominical ? "permitidos" : "no"}</li>
          </ul>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button onClick={preview} disabled={loading}>{loading ? "Calculando..." : "Generar vista previa"}</button>
      </div>

      {error && <p style={{ color: "crimson", marginTop: 12 }}>⚠️ {error}</p>}

      {data?.ok && (
        <>
          <div style={{ marginTop: 16, background: "#eefbf0", padding: 12, borderRadius: 8 }}>
            <h3>Resumen</h3>
            <ul>
              <li>Alumnos (con elegibilidades): {data.summary.students_total}</li>
              <li>Cursos con demanda: {data.summary.courses_with_demand}</li>
              <li>Grupos programados: {data.summary.scheduled_groups}</li>
              <li>Asignaciones propuestas: {data.summary.proposed_assignments}</li>
            </ul>
          </div>

          {/* Tabs */}
          <div style={{ marginTop: 16, borderBottom: "1px solid #ddd", display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setTab("materias")}
              style={{
                border: "none",
                background: "transparent",
                padding: "8px 12px",
                borderBottom: tab === "materias" ? "3px solid #3b82f6" : "3px solid transparent",
                fontWeight: tab === "materias" ? 700 : 400,
                cursor: "pointer"
              }}
            >
              Materias
            </button>
            <button
              type="button"
              onClick={() => setTab("alumnos")}
              style={{
                border: "none",
                background: "transparent",
                padding: "8px 12px",
                borderBottom: tab === "alumnos" ? "3px solid #3b82f6" : "3px solid transparent",
                fontWeight: tab === "alumnos" ? 700 : 400,
                cursor: "pointer"
              }}
            >
              Alumnos
            </button>
            <button
              type="button"
              onClick={() => setTab("horarios")}
              style={{
                border: "none",
                background: "transparent",
                padding: "8px 12px",
                borderBottom: tab === "horarios" ? "3px solid #3b82f6" : "3px solid transparent",
                fontWeight: tab === "horarios" ? 700 : 400,
                cursor: "pointer"
              }}
            >
              Horarios
            </button>
          </div>

          {/* =========== TAB MATERIAS =========== */}
          {tab === "materias" && (
            <>
              <h3 style={{ marginTop: 16 }}>Grupos y horarios generados</h3>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Curso</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Turno</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Grupo</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Salon</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Dia</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Slot</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Inicio</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Fin</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Cap</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Usados</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {data.scheduled_groups.map((g: any, i: number) => (
                    <tr key={i}>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.course_code}</td>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0", textTransform: "capitalize" }}>{g.turno}</td>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>G{g.group_index}</td>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.room}</td>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{dayName(g.day_of_week)}</td>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.slot_index}</td>
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
                {data.unassigned_by_course?.map((u: any) => (
                  <li key={u.course_id}>{u.course_code}: {u.count}</li>
                ))}
              </ul>
            </>
          )}

          {/* =========== TAB ALUMNOS =========== */}
          {tab === "alumnos" && (
            <>
              <h3 style={{ marginTop: 16 }}>Alumnos (asignadas / disponibles)</h3>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Alumno</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Turno</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Asignadas/Disponibles</th>
                  </tr>
                </thead>
                <tbody>
                  {data.students_overview?.map((s: any) => (
                    <tr key={s.student_id}>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>
                        {s.student_name || "(sin nombre)"}<div style={{ color:"#888", fontSize:12 }}>{s.student_id}</div>
                      </td>
                      <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0", textTransform: "capitalize" }}>{s.shift || "—"}</td>
                      <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{s.assignments}/{s.eligible}</td>
                    </tr>
                  ))}
                  {(!data.students_overview || data.students_overview.length === 0) && (
                    <tr><td colSpan={3} style={{ padding: 6 }}>Sin datos</td></tr>
                  )}
                </tbody>
              </table>
            </>
          )}

          {/* =========== TAB HORARIOS =========== */}
          {tab === "horarios" && (
            <>
              <h3 style={{ marginTop: 16 }}>Buscar horarios</h3>

              {/* Buscador alumno */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
                <div>
                  <label>Alumno</label>
                  <input
                    list="students-list"
                    placeholder="Escribe nombre o ID..."
                    value={studentQuery}
                    onChange={(e) => setStudentQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") pickStudentFromQuery(); }}
                    style={{ width: "100%" }}
                  />
                  <datalist id="students-list">
                    {studentOptions.slice(0, 500).map((s: any) => (
                      <option key={s.id} value={s.label} />
                    ))}
                  </datalist>
                  <div style={{ marginTop: 8 }}>
                    <button type="button" onClick={pickStudentFromQuery}>Ver horario</button>
                    {selectedStudentId && (
                      <span style={{ marginLeft: 8, color: "#555" }}>Seleccionado: {selectedStudentLabel}</span>
                    )}
                  </div>
                </div>

                {/* Buscador salon */}
                <div>
                  <label>Salon</label>
                  <input
                    list="rooms-list"
                    placeholder="Escribe codigo de salon..."
                    value={roomQuery}
                    onChange={(e) => setRoomQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") pickRoomFromQuery(); }}
                    style={{ width: "100%" }}
                  />
                  <datalist id="rooms-list">
                    {roomOptions.slice(0, 500).map((r: any) => (
                      <option key={r.code} value={r.code} />
                    ))}
                  </datalist>
                  <div style={{ marginTop: 8 }}>
                    <button type="button" onClick={pickRoomFromQuery}>Ver horario</button>
                    {selectedRoomCode && (
                      <span style={{ marginLeft: 8, color: "#555" }}>Seleccionado: {selectedRoomCode}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Resultado: horario de alumno */}
              {selectedStudentId && (
                <div style={{ marginTop: 16 }}>
                  <h4>Horario del alumno</h4>
                  {studentSchedule.length === 0 ? (
                    <p style={{ color: "#666" }}>Sin clases asignadas para este alumno en la vista previa.</p>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Dia</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Inicio</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Fin</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Curso</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Salon</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Turno</th>
                        </tr>
                      </thead>
                      <tbody>
                        {studentSchedule.map((it: any, i: number) => (
                          <tr key={i}>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{dayName(it.day_of_week)}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{it.start_time.slice(0,5)}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{it.end_time.slice(0,5)}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{it.course_code}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{it.room_code}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid " + "#f0f0f0" }}>{it.shift || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Resultado: horario de salon */}
              {selectedRoomCode && (
                <div style={{ marginTop: 16 }}>
                  <h4>Horario del salon</h4>
                  {roomSchedule.length === 0 ? (
                    <p style={{ color: "#666" }}>Este salon no tiene clases en la vista previa.</p>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Dia</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Inicio</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Fin</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid " + "#ddd", padding: 6 }}>Curso</th>
                          <th style={{ textAlign: "left", borderBottom: "1px solid " + "#ddd", padding: 6 }}>Turno</th>
                          <th style={{ textAlign: "right", borderBottom: "1px solid " + "#ddd", padding: 6 }}>Cap</th>
                          <th style={{ textAlign: "right", borderBottom: "1px solid " + "#ddd", padding: 6 }}>Usados</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roomSchedule.map((g: any, i: number) => (
                          <tr key={i}>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{dayName(g.day_of_week)}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.start_time.slice(0,5)}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.end_time.slice(0,5)}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0" }}>{g.course_code}</td>
                            <td style={{ padding: 6, borderBottom: "1px solid #f0f0f0", textTransform: "capitalize" }}>{g.turno}</td>
                            <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{g.capacity}</td>
                            <td style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #f0f0f0" }}>{g.used}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
