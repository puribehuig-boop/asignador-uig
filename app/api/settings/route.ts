import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const SettingsSchema = z.object({
  max_courses_per_student: z.coerce.number().int().min(1).max(20),
  target_group_size: z.coerce.number().int().min(5).max(150),
  slot_length_minutes: z.coerce.number().int().min(30).max(240),
  day_start: z.string().regex(/^\d{2}:\d{2}$/), // HH:MM
  day_end: z.string().regex(/^\d{2}:\d{2}$/),
  days_active: z.array(z.number().int().min(1).max(7)).nonempty(),
});

const DEFAULTS = {
  max_courses_per_student: 5,
  target_group_size: 30,
  slot_length_minutes: 90,
  day_start: "07:00",
  day_end: "21:00",
  days_active: [1,2,3,4,5],
};

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("system_settings")
    .select("settings")
    .eq("id", "general")
    .single();

  if (error || !data?.settings) {
    return NextResponse.json({ ok: true, settings: DEFAULTS, from: "defaults" });
  }
  return NextResponse.json({ ok: true, settings: data.settings, from: "db" });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Datos inválidos" }, { status: 400 });
    }
    const payload = parsed.data;
    const { error } = await supabaseAdmin
      .from("system_settings")
      .upsert({ id: "general", settings: payload, updated_at: new Date().toISOString() });

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, settings: payload });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
