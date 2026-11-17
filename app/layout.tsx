import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Goncy Evaluations — Evaluador de Challenges",
  description: "Analizá en lote los proyectos de un challenge: subí un CSV o pegá los enlaces, definí criterios y dejá que la IA genere un reporte comparativo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
