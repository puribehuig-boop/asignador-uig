import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const RoomSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(1),
  name: z.string().nullable().optional(),
  capacity: z.number().int().positive(),
});

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("rooms")
    .select("id, code, name, capacity")
    .order("code", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rooms: data });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = RoomSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Datos inválidos" }, { status: 400 });
    }

    const payload = parsed.data;
    // upsert por code si no viene id
    if (!payload.id) {
      const { data, error } = await supabaseAdmin
        .from("rooms")
        .upsert({ code: payload.code, name: payload.name ?? null, capacity: payload.capacity }, { onConflict: "code" })
        .select("id, code, name, capacity")
        .single();
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, room: data });
    } else {
      const { data, error } = await supabaseAdmin
        .from("rooms")
        .update({ code: payload.code, name: payload.name ?? null, capacity: payload.capacity })
        .eq("id", payload.id)
        .select("id, code, name, capacity")
        .single();
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, room: data });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
