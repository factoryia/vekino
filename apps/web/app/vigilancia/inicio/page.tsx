"use client";

import { useQuery } from "convex/react";
import { api } from "@vekino/backend/api";
import { PanelOperacion } from "@/components/vigilancia/panel-operacion";
import { PageContainer } from "@/components/layout/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";

export default function InicioCompania() {
  const compania = useQuery(api.companias.miCompania);
  if (compania === undefined) return <PageContainer><Skeleton className="h-64" /></PageContainer>;
  if (!compania?.roles.includes("admin_compania")) return <PageContainer><p>Este panel requiere administrador de compañía.</p><Link href="/vigilancia" className="text-brand underline">Volver a mis conjuntos</Link></PageContainer>;
  return <PanelOperacion />;
}
