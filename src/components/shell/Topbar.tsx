import { Bell, Plus, Search } from "lucide-react";

import { Button } from "@components/ui/Button";
import { IconButton } from "@components/ui/IconButton";
import { StatusPill } from "@components/ui/StatusPill";

export function Topbar() {
  return (
    <header className="topbar">
      <div className="topbar__title">
        <span className="eyebrow">Production</span>
        <span className="topbar__heading">Control plane</span>
      </div>
      <div className="topbar__command">
        <label className="topbar__search">
          <Search aria-hidden="true" size={15} />
          <span className="sr-only">Search SiteFlow</span>
          <input
            className="topbar__search-input"
            name="global-search"
            autoComplete="off"
            placeholder="Search projects, deployments, routes..."
            type="search"
          />
          <kbd>/</kbd>
        </label>
      </div>
      <div className="topbar__actions">
        <StatusPill tone="success">All systems nominal</StatusPill>
        <IconButton label="Search" icon={<Search aria-hidden="true" size={17} />} />
        <IconButton label="Notifications" icon={<Bell aria-hidden="true" size={17} />} />
        <Button variant="primary" icon={<Plus aria-hidden="true" size={16} />}>
          New project
        </Button>
      </div>
    </header>
  );
}
