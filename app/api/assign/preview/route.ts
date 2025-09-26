import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Shift = "matutino" | "vespertino" | "sabatino" | "dominical";
type Meeting = { day: number; start: number; end: number; shift: Shift };
type Room = { id: string; code: string; capacity: number };
type Course = { id: string; code: string; name: string | null };
type Student = { id: string; shift: Shift | null };

const SHIFT_DAYS: Record<Shift, number[]> = {
  matutino: [1,2,3,4,5],      // L-V
  vespertino: [1,2,3,4,5],    // L-V
  sabatino: [6],              // Sábado
  dominical: [7],             // Domingo
};

function hhmmToMin(hhmm: string) { const [h,m] = hhmm.split(":").map(Number); return (h||0)*60+(m||0); }
function minToHHMM(m: number) { const h = Math.floor(m/60), mm = m%60; return `${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00`; }
function conflict(a: Meeting, b: Meeting) { return a.day===b.day && Math.max(a.start,b.start)<Math.min(a.end,b.end); }

export async function POST() {
  try {
    // 0) Cargar ajustes
    const { data: sRow } = await supabaseAdmin.from("system_settings").select("settings").eq("id","general").single();
    const S = sRow?.settings ?? {
      max_courses_per_student: 5,
      target_group_size: 30,
      slot_length_minutes: 90,
      start_matutino: "07:00",
      start_vespertino: "16:00",
      start_sabatino: "08:00",
      start_dominical: "08:00",
    };

    // 1) Datos base
    const [{ data: elig }, { data: courses }, { data: rooms }, { data: students }] = await Promise.all([
      supabaseAdmin.from("student_eligibilities").select("student_id, course_id"),
      supabaseAdmin.from("courses").select("id, code, name"),
      supabaseAdmin.from("rooms").select("id, code, capacity"),
      supabaseAdmin.from("students").select("id, shift"),
    ]);

    const coursesArr = (courses ?? []) as Course[];
    const roomsArr = (rooms ?? []) as Room[];
    const studentShift = new Map((students ?? []).map((s: any) => [s.id, (s.shift ?? null) as Shift | null]));

    // 2) Demanda total y por turno
    const demandByCourse = new Map<string, number>();
    const demandByCourseShift = new Map<string, Record<Shift, number>>();
    const eligByStudent = new Map<string, string[]>();

    for (const row of (elig ?? [])) {
      const sid = row.student_id;
      const cid = row.course_id;
      const sh = (studentShift.get(sid) || "matutino") as Shift; // default: matutino si no viene

      demandByCourse.set(cid, (demandByCourse.get(cid) || 0) + 1);
