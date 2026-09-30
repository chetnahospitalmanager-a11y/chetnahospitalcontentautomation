import { getKv, setKv, type PostKind } from './db.ts';
import {
  doctorsInDepartment,
  findDepartment,
  findDoctor,
  loadHospital,
  postableDepartments,
  spotlightDoctors,
} from './hospital.ts';

export interface Topic {
  kind: PostKind;
  /** doctor slug, department slug, hospital topic key, or the free text of a custom topic */
  subject: string;
  title: string;
  /** Facts Gemini may use. It must not add any others. */
  facts: string[];
  imageKey: string;
}

const PATTERN: PostKind[] = ['doctor', 'department', 'doctor', 'department', 'hospital'];

export function doctorTopic(slug: string): Topic | null {
  const d = findDoctor(slug);
  if (!d) return null;
  const dept = d.department ? findDepartment(d.department) : undefined;
  const facts = [
    `Doctor: ${d.name}`,
    d.qualification && `Qualification: ${d.qualification}`,
    d.speciality && `Speciality: ${d.speciality}`,
    dept && `Department: ${dept.name}`,
    d.bio && `About: ${d.bio}`,
  ].filter(Boolean) as string[];
  return { kind: 'doctor', subject: d.slug, title: `Doctor spotlight: ${d.name}`, facts, imageKey: `doctor-${d.slug}` };
}

export function departmentTopic(slug: string): Topic | null {
  const dept = findDepartment(slug);
  if (!dept) return null;
  const doctors = doctorsInDepartment(slug);
  const facts = [
    `Department: ${dept.name}`,
    dept.brief && `What it covers: ${dept.brief}`,
    doctors.length > 0 && `Doctors: ${doctors.map((d) => d.name).join(', ')}`,
  ].filter(Boolean) as string[];
  return { kind: 'department', subject: dept.slug, title: `Department: ${dept.name}`, facts, imageKey: `department-${dept.slug}` };
}

export function hospitalTopic(key: string): Topic | null {
  const t = loadHospital().hospital.topics.find((x) => x.key === key);
  if (!t) return null;
  return { kind: 'hospital', subject: t.key, title: t.label, facts: [t.brief], imageKey: `hospital-${t.key}` };
}

export function customTopic(text: string): Topic {
  const clean = text.trim().slice(0, 200);
  return { kind: 'custom', subject: clean, title: clean, facts: [`Topic requested by staff: ${clean}`], imageKey: 'hospital' };
}

function candidates(kind: PostKind): string[] {
  if (kind === 'doctor') return spotlightDoctors().map((d) => d.slug);
  if (kind === 'department') return postableDepartments().map((d) => d.slug);
  if (kind === 'hospital') return loadHospital().hospital.topics.map((t) => t.key);
  return [];
}

function build(kind: PostKind, subject: string): Topic | null {
  if (kind === 'doctor') return doctorTopic(subject);
  if (kind === 'department') return departmentTopic(subject);
  if (kind === 'hospital') return hospitalTopic(subject);
  return null;
}

/**
 * Next topic in the rotation doctor → department → doctor → department → hospital-wide.
 * Categories with nothing to post (e.g. no doctor has a speciality filled in yet) are skipped.
 */
export async function nextTopic(): Promise<Topic> {
  let step = Number((await getKv('rotation:step')) ?? '0');
  for (let tries = 0; tries < PATTERN.length; tries++) {
    const kind = PATTERN[step % PATTERN.length];
    step++;
    const list = candidates(kind);
    if (list.length === 0) continue;
    const idx = Number((await getKv(`rotation:${kind}`)) ?? '0');
    const topic = build(kind, list[idx % list.length]);
    await setKv(`rotation:${kind}`, String((idx + 1) % list.length));
    await setKv('rotation:step', String(step % PATTERN.length));
    if (topic) return topic;
  }
  // Nothing configured at all: fall back to a general hospital post.
  return customTopic(`About ${loadHospital().hospital.name}`);
}

export function topicFor(kind: PostKind, subject: string): Topic | null {
  return kind === 'custom' ? customTopic(subject) : build(kind, subject);
}
