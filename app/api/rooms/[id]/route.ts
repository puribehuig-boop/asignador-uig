import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const { error } = await supabaseAdmin.from("rooms").delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
