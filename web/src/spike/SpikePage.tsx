import "@bryntum/schedulerpro/schedulerpro.css";
import "@bryntum/schedulerpro/svalbard-light.css";
import "@bryntum/schedulerpro/fontawesome/css/fontawesome.css";
import "@bryntum/schedulerpro/fontawesome/css/solid.css";
import { BryntumSchedulerPro, BryntumSchedulerProProjectModel } from "@bryntum/schedulerpro-react";
import { enableStudioDevValidations } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { useMemo, useRef, useState } from "react";
import { readLicenses, schedulerDemoProject, studioDemoData, studioDemoReport } from "./demo-data.ts";

// R3 spike: one AG Studio widget and one Bryntum Scheduler Pro timeline on one page.
if (import.meta.env.DEV) enableStudioDevValidations();

const licenses = readLicenses(import.meta.env);

export function SpikePage() {
  // Studio and Bryntum both want stable object props (AG Studio best practices; Bryntum re-applies changed configs).
  const [initialState] = useState(() => studioDemoReport);
  const project = useMemo(() => schedulerDemoProject(), []);
  // Bryntum's React guide: hold the data in a ProjectModel component and pass its ref, not inline store configs.
  const projectRef = useRef<BryntumSchedulerProProjectModel>(null);

  return (
    // Grid rows give both components a definite height; Bryntum otherwise falls back to its min-height.
    <div style={{ display: "grid", gridTemplateRows: "auto minmax(300px, 1fr) minmax(300px, 1fr)", height: "100vh", fontFamily: "system-ui" }}>
      <header style={{ padding: "8px 16px", borderBottom: "1px solid #ddd" }}>
        <strong>R3 spike</strong>: AG Studio {licenses.agStudio ? "(licence key from env)" : "(no VITE_AG_STUDIO_LICENSE_KEY: evaluation mode)"} +
        Bryntum Scheduler Pro (trial package)
      </header>
      <section style={{ minHeight: 0 }}>
        <AgStudioProvider {...(licenses.agStudio ? { licenseKey: licenses.agStudio } : {})}>
          <AgStudio style={{ height: "100%", width: "100%" }} data={studioDemoData} initialState={initialState} mode="view" />
        </AgStudioProvider>
      </section>
      <section style={{ minHeight: 0, borderTop: "1px solid #ddd" }}>
        <BryntumSchedulerProProjectModel
          ref={projectRef}
          resources={project.resources}
          events={project.events}
          assignments={project.assignments}
          dependencies={project.dependencies}
        />
        <BryntumSchedulerPro
          startDate={new Date(2026, 9, 29)}
          endDate={new Date(2026, 10, 6)}
          viewPreset="dayAndWeek"
          rowHeight={50}
          columns={[{ type: "resourceInfo", text: "Lane", width: 180 }]}
          project={projectRef}
        />
      </section>
    </div>
  );
}
