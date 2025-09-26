import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Asignador UIG",
  description:
    "Asignación factible de alumnos-materias-grupos-salones-horarios",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
