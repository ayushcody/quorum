import type { AgDataSourcesDefinition, AgReportState } from "ag-studio";

// R3 spike (docs/PLAN.md S1.3): dummy data for one AG Studio widget and one Bryntum Scheduler Pro
// timeline on the same page. Pure data and checks only, so it is testable without a DOM.

// --- AG Studio --------------------------------------------------------------------

export const studioDemoData: AgDataSourcesDefinition = {
  description: "Demo pledges for one Quorum buying round (dummy data).",
  sources: [
    {
      id: "pledges",
      name: "Pledges",
      data: [
        { member: "Maya's Café", qtyKg: 30, maxPricePerKg: 14, status: "authorized" },
        { member: "Bean There", qtyKg: 45, maxPricePerKg: 13.5, status: "authorized" },
        { member: "Corner Roast", qtyKg: 25, maxPricePerKg: 15, status: "pending" },
        { member: "Daily Grind", qtyKg: 60, maxPricePerKg: 12.75, status: "authorized" },
      ],
      fields: [
        { id: "member", name: "Member", format: "textFormat" },
        { id: "qtyKg", name: "Quantity (kg)", format: "integerFormat" },
        { id: "maxPricePerKg", name: "Max $/kg", format: "currencyFormat" },
        { id: "status", name: "Authorization", format: "textFormat" },
      ],
    },
  ],
};

export const studioDemoReport: AgReportState = {
  selectedPageId: "spike",
  pages: [
    {
      id: "spike",
      widgets: {
        pledges: {
          type: "grid",
          dataMapping: {
            cols: [{ id: "pledges.member" }, { id: "pledges.qtyKg" }, { id: "pledges.maxPricePerKg" }, { id: "pledges.status" }],
          },
        },
      },
      widgetLayout: { pledges: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 14 } },
    },
  ],
};

// Field ids a report maps that no data source defines. Studio reports these at runtime; catching
// them here keeps the page free of console errors. Ids without a "source.field" shape (calendar
// keys like "calendar::month", expression measures) are not checked.
export function unknownFieldRefs(report: AgReportState, data: AgDataSourcesDefinition): string[] {
  // Not every AgDataSource variant declares fields (some infer them from data), so read them structurally.
  const fieldsOf = (s: unknown) => (s as { fields?: Array<{ id: string }> }).fields ?? [];
  const known = new Set(data.sources.flatMap((s) => fieldsOf(s).map((f) => `${s.id}.${f.id}`)));
  const refs: string[] = [];
  for (const page of report.pages ?? []) {
    for (const widget of Object.values(page.widgets ?? {})) {
      const mapping = (widget as unknown as { dataMapping?: Record<string, Array<{ id?: string }>> }).dataMapping ?? {};
      for (const slot of Object.values(mapping)) {
        for (const item of slot ?? []) {
          if (item.id && /^[^:.]+\.[^:.]+$/.test(item.id) && !known.has(item.id)) refs.push(item.id);
        }
      }
    }
  }
  return refs;
}

// --- Bryntum Scheduler Pro --------------------------------------------------------

type DemoEvent = { id: number; name: string; startDate: string; duration: number; durationUnit: "d" | "h" };

export function schedulerDemoProject() {
  const resources = [
    { id: 1, name: "Members" },
    { id: 2, name: "Coalition agent" },
    { id: 3, name: "Settlement" },
    { id: 4, name: "Supplier" },
  ];
  const events: DemoEvent[] = [
    { id: 1, name: "Pledge window", startDate: "2026-10-29", duration: 2, durationUnit: "d" },
    { id: 2, name: "Negotiation", startDate: "2026-10-30", duration: 1, durationUnit: "d" },
    { id: 3, name: "Quorum reached", startDate: "2026-10-31", duration: 0, durationUnit: "d" },
    { id: 4, name: "Capture", startDate: "2026-10-31", duration: 4, durationUnit: "h" },
    { id: 5, name: "Delivery", startDate: "2026-11-02", duration: 3, durationUnit: "d" },
  ];
  const assignments = [
    { id: 1, event: 1, resource: 1 },
    { id: 2, event: 2, resource: 2 },
    { id: 3, event: 3, resource: 2 },
    { id: 4, event: 4, resource: 3 },
    { id: 5, event: 5, resource: 4 },
  ];
  // Payment-gated chain: capture waits on quorum, delivery waits on capture.
  const dependencies = [
    { id: 1, fromEvent: 1, toEvent: 3 },
    { id: 2, fromEvent: 2, toEvent: 3 },
    { id: 3, fromEvent: 3, toEvent: 4 },
    { id: 4, fromEvent: 4, toEvent: 5 },
  ];
  return { resources, events, assignments, dependencies };
}

// --- Licences ---------------------------------------------------------------------

// AG Studio takes a key at runtime (AgStudioProvider licenseKey). Bryntum has no runtime key: trial
// vs licensed is which npm package is installed (DECISIONS D5).
export function readLicenses(env: Record<string, string | undefined>): { agStudio: string | undefined } {
  const key = env.VITE_AG_STUDIO_LICENSE_KEY?.trim();
  return { agStudio: key ? key : undefined };
}
