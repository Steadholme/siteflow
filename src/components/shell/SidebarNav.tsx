import type { LucideIcon } from "lucide-react";
import { Folder, History, Package, Rocket, Route, Settings } from "lucide-react";
import { NavLink } from "react-router-dom";

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { label: "Projects", to: "/projects", icon: Folder },
  { label: "Deployments", to: "/deployments/current", icon: Rocket },
  { label: "Routes", to: "/projects/core-api/release/production", icon: Route },
  { label: "Artifacts", to: "/deployments/artifact-ledger", icon: Package },
  { label: "Audit", to: "/projects/core-api/rollback/production", icon: History },
  { label: "Settings", to: "/projects/core-api", icon: Settings }
];

export function SidebarNav() {
  return (
    <aside className="sidebar" aria-label="SiteFlow">
      <div className="sidebar__brand" aria-label="SiteFlow home">
        <span className="sidebar__brand-mark" aria-hidden="true">
          SF
        </span>
        <span className="sidebar__brand-copy">
          <span>SiteFlow</span>
          <span className="sidebar__brand-kicker">Deploy platform</span>
        </span>
      </div>
      <span className="sidebar__section-label">Workspace</span>
      <nav className="sidebar__nav" aria-label="Primary navigation">
        {navItems.map(({ label, to, icon: Icon }) => (
          <NavLink key={label} to={to} className={({ isActive }) => (isActive ? "sidebar__link is-active" : "sidebar__link")}>
            <Icon aria-hidden="true" size={17} strokeWidth={2} />
            <span className="sidebar__nav-label">{label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
