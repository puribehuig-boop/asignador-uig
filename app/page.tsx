export default function Home() {
  return (
    <main style={{ padding: 24, lineHeight: 1.4 }}>
      <h1>Asignador UIG</h1>
      <p style={{ color: "#555" }}>Flujo recomendado</p>

      <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: 12, maxWidth: 900 }}>
        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 1</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Cargar elegibilidades</div>
          <p>Sube el CSV de <em>alumno → materias posibles</em>.</p>
          <a href="/upload">Ir a /upload →</a>
        </li>

        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 2</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Revisar salones y restricciones</div>
          <p>Administra salones y ajusta parámetros globales de asignación.</p>
          <a href="/settings">Ir a Ajustes (General) →</a>
        </li>

        <li style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Paso 3</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Asignar y ver vista previa</div>
          <p>Genera grupos, horarios y la asignación propuesta sin escribir en la base de datos.</p>
          <a href="/assign">Ir a Vista previa →</a>
        </li>
      </ol>
    </main>
  );
}
