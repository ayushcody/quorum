import { describe, expect, it } from "vitest";
import { readLicenses, schedulerDemoProject, studioDemoData, studioDemoReport, unknownFieldRefs } from "./demo-data.ts";

describe("AG Studio demo data", () => {
  it("every field a widget maps exists in a data source", () => {
    expect(unknownFieldRefs(studioDemoReport, studioDemoData)).toEqual([]);
  });

  it("catches a widget that maps a missing field", () => {
    const broken = structuredClone(studioDemoReport);
    const page = broken.pages![0]!;
    page.widgets = { ...page.widgets, bad: { type: "grid", dataMapping: { cols: [{ id: "pledges.nope" }] } } } as typeof page.widgets;
    expect(unknownFieldRefs(broken, studioDemoData)).toEqual(["pledges.nope"]);
  });

  it("lays out every widget on the page", () => {
    const page = studioDemoReport.pages![0]!;
    expect(Object.keys(page.widgetLayout ?? {}).sort()).toEqual(Object.keys(page.widgets ?? {}).sort());
  });
});

describe("Bryntum demo project", () => {
  const project = schedulerDemoProject();
  const ids = (rows: Array<{ id?: unknown }>) => new Set(rows.map((r) => r.id));

  it("assignments and dependencies only reference existing rows", () => {
    const events = ids(project.events);
    const resources = ids(project.resources);
    for (const a of project.assignments) {
      expect(events.has(a.event), `event ${String(a.event)}`).toBe(true);
      expect(resources.has(a.resource), `resource ${String(a.resource)}`).toBe(true);
    }
    for (const d of project.dependencies) {
      expect(events.has(d.fromEvent) && events.has(d.toEvent)).toBe(true);
    }
  });

  it("gates capture on quorum and delivery on capture (payment-gated chain)", () => {
    const name = (id: unknown) => project.events.find((e) => e.id === id)?.name;
    const edges = project.dependencies.map((d) => `${name(d.fromEvent)} -> ${name(d.toEvent)}`);
    expect(edges).toContain("Quorum reached -> Capture");
    expect(edges).toContain("Capture -> Delivery");
  });
});

describe("readLicenses", () => {
  it("reads the AG Studio key from VITE_AG_STUDIO_LICENSE_KEY", () => {
    expect(readLicenses({ VITE_AG_STUDIO_LICENSE_KEY: " key-123 " })).toEqual({ agStudio: "key-123" });
  });

  it("treats a missing or blank key as absent", () => {
    expect(readLicenses({})).toEqual({ agStudio: undefined });
    expect(readLicenses({ VITE_AG_STUDIO_LICENSE_KEY: "  " })).toEqual({ agStudio: undefined });
  });
});
