import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface HospitalTopic {
  key: string;
  label: string;
  brief: string;
}

export interface Department {
  slug: string;
  name: string;
  brief: string;
}

export interface Doctor {
  slug: string;
  name: string;
  qualification: string;
  speciality: string;
  department: string;
  bio: string;
  /** false = listed (e.g. for department posts and Google profile matching) but never spotlighted on its own */
  spotlight?: boolean;
  /** Other names the doctor's Google profile or Facebook Page might use, e.g. "Dr. Rachana Tiwari". */
  aliases?: string[];
  /** Pin the doctor's own Facebook Page instead of matching it by name. */
  facebookPageId?: string;
}

export interface HospitalData {
  hospital: {
    name: string;
    shortName: string;
    location: string;
    website: string;
    hashtags: string[];
    facts: string[];
    topics: HospitalTopic[];
  };
  departments: Department[];
  doctors: Doctor[];
}

const DATA_PATH = fileURLToPath(new URL('../data/hospital.json', import.meta.url));

let cached: HospitalData | null = null;

export function loadHospital(): HospitalData {
  if (!cached) cached = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as HospitalData;
  return cached;
}

/** For tests. */
export function setHospitalData(data: HospitalData | null): void {
  cached = data;
}

export function findDoctor(slug: string): Doctor | undefined {
  return loadHospital().doctors.find((d) => d.slug === slug);
}

export function findDepartment(slug: string): Department | undefined {
  return loadHospital().departments.find((d) => d.slug === slug);
}

export function doctorsInDepartment(slug: string): Doctor[] {
  return loadHospital().doctors.filter((d) => d.department === slug);
}

/** Doctors with enough facts for Gemini to write about without inventing anything. */
export function spotlightDoctors(): Doctor[] {
  return loadHospital().doctors.filter((d) => d.speciality.trim() !== '' && d.spotlight !== false);
}

export function postableDepartments(): Department[] {
  return loadHospital().departments.filter(
    (d) => d.brief.trim() !== '' || doctorsInDepartment(d.slug).length > 0,
  );
}
