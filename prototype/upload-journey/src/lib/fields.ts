// PLACEHOLDER fields. The real set comes from the ResourceSpace inventory
// task (map 12). Required flags here are guesses, to exercise the UX.
export type Meta = {
  description: string;
  event: string;
  date: string;
  people: string;
  permission: boolean;
};

export const EMPTY_META: Meta = {
  description: "",
  event: "",
  date: "",
  people: "",
  permission: false,
};

export const EVENTS = [
  "Design in Wood",
  "A class or workshop",
  "A shop project",
  "A club or SIG meeting",
  "Something else",
];

export const FIELD_LABELS: Record<keyof Meta, string> = {
  description: "What are these?",
  event: "Where were they taken?",
  date: "When were they taken?",
  people: "Who is in them?",
  permission: "I took these, or I have permission to share them",
};

export const REQUIRED: (keyof Meta)[] = ["description", "event", "permission"];

export function missing(meta: Meta): string[] {
  return REQUIRED.filter((k) => !meta[k]).map((k) => FIELD_LABELS[k]);
}
