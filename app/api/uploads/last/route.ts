import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // evita caching de Next/Vercel
export const revalidate = 0;

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("file_uploads")
    .select("*")
    .order("uploaded_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const last = data?.[0] || null;

  return NextResponse.json(
    last
      ? {
          ok: true,
          last: {
            filename: last.filename,
            uploaded_at: last.uploaded_at,
            rows_total: last.rows_total,
            rows_valid: last.rows_valid,
            rows_invalid: last.rows_invalid,
            students_upserted: last.students_upserted,
            courses_upserted: last.courses_upserted,
            eligibilities_upserted: last.eligibilities_upserted,
          },
        }
      : { ok: true, last: null },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate" } }
  );
}
