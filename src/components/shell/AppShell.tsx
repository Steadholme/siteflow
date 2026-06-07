import { Outlet } from "react-router-dom";

import { SidebarNav } from "@components/shell/SidebarNav";
import { Topbar } from "@components/shell/Topbar";

export function AppShell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#siteflow-main">
        Skip to content
      </a>
      <SidebarNav />
      <div className="app-shell__workspace">
        <Topbar />
        <main id="siteflow-main" className="app-shell__content" aria-label="SiteFlow workspace" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
