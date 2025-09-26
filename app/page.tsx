export default function Home() {
  return (
    <main style={{ padding: 24, lineHeight: 1.4 }}>
      <h1>Asignador UIG</h1>
      <ul>
        <li><a href="/upload">Cargar elegibilidades (alumno → materias posibles)</a></li>
        <li><a href="/setup/rooms">Gestionar salones</a></li>
        <li><a href="/assign">Vista previa de asignación (grupos+horarios generados)</a></li>
      </ul>
    </main>
  );
}
