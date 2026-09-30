"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { PageContainer } from "@/components/layout/page-container";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function GuardiaIncidenteError({ reset }: { error: Error; reset: () => void }) {
  const { id } = useParams<{ id: string }>();
  return <PageContainer className="mx-auto w-full max-w-3xl"><Card className="space-y-3 p-6"><h1 className="text-lg font-semibold">No se pudo abrir el incidente</h1><p className="text-sm text-muted-foreground">Puede que ya no tengas acceso a este caso o que la sesión haya terminado.</p><div className="flex flex-wrap gap-2"><Button type="button" onClick={reset}>Reintentar</Button><Button variant="outline" asChild><Link href={`/guardia/${id}/incidentes`}>Volver a Incidentes</Link></Button></div></Card></PageContainer>;
}
