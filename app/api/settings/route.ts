import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

const HHMM = /^\d{2}:\d{2}$/;

const SettingsSchema = z.object({
  max_courses_per_student: z.coerce.number().int().min(1).max(20),

  start_matutino: z.string().regex(HHMM),
  duration_matutino: z.coerce.number().int().min(30).max(240),
  allow_breaks_matutino: z.coerce.boolean(),
  slots_per_day_matutino: z.coerce.number().int().min(1).max(12),

  start_vespertino: z.string().regex(HHMM),
  duration_vespertino: z.coerce.number().int().min(30).max(240),
  allow_breaks_vespertino: z.coerce.boolean(),
  slots_per_day_vespertino: z.coerce.number().int().min(1).max(12),

  start_sabatino: z.string().regex(HHMM),
  duration_sabatino: z.coerce.number().int().min(30).max(240),
  allow_breaks_sabatino: z.coerce.boolean(),
  slots_per_day_sabatino: z.coerce.number().int().min(1).max(12),

  start_dominical: z.string().regex(HHMM),
  duration_dominical: z.coerce.number().int().min(30).max(240),
  allow_breaks_dominical: z.coerce.boolean(),
  slots_per_day_dominical: z.coerce.number().int().min(1).max(12),
});

const DEFAULTS = {
  max_courses_per_student: 5,

  start_matutino: "07:00",
  duration_matutino: 90,
  allow_breaks_matutino: true,
  slots_per_day_matutino: 5,

  start_vespertino: "16:00",
  duration_vespertino: 90,
  allow_breaks_vespertino: true,
  slots_per_day_vespertino: 4,

  start_sabatino: "08:00",
  duration_sabatino: 90,
  allow_breaks_sabatino: true,
  slots_per_day_sabatino: 4,

  start_dominical: "08:00",
  duration_dominical: 90,
  allow_breaks_dominical: true,
  slots_per_day_dominical: 4,
};

export async function GET() {
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("settings")
    .eq("id", "general")
    .single();
  return NextResponse.json({ ok: true, settings: { ...DEFAULTS, ...(data?.settings ?? {}) } });
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
