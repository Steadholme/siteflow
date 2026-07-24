import type { LucideIcon } from "lucide-react";
import { Folder, GitBranch, History, Rocket } from "lucide-react";
import { NavLink, useParams } from "react-router-dom";

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

const yardItems: NavItem[] = [{ label: "Projects", to: "/projects", icon: Folder }];

function NavigationGroup({
  label,
  items
}: {
  label: string;
  items: NavItem[];
}) {
  return (
    <div className="sidebar__group">
      <span className="sidebar__section-label">{label}</span>
      <nav className="sidebar__nav" aria-label={label}>
        {items.map(({ label: itemLabel, to, icon: Icon }) => (
          <NavLink
            key={itemLabel}
            to={to}
            end
            className={({ isActive }) => (isActive ? "sidebar__link is-active" : "sidebar__link")}
          >
            <Icon aria-hidden="true" size={17} strokeWidth={2} />
            <span className="sidebar__nav-label">{itemLabel}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function SidebarNav() {
  const { projectId } = useParams();
  const projectPath = projectId ? encodeURIComponent(projectId) : null;
  const projectItems: NavItem[] = projectPath
    ? [
        {
          label: "Project board",
          to: `/projects/${projectPath}`,
          icon: GitBranch
        },
        {
          label: "Promote to production",
          to: `/projects/${projectPath}/release/production`,
          icon: Rocket
        },
        {
          label: "Rollback production",
          to: `/projects/${projectPath}/rollback/production`,
          icon: History
        }
      ]
    : [];

  return (
    <aside className="sidebar" aria-label="SiteFlow operator console">
      <div className="sidebar__brand" aria-label="SiteFlow home">
        <span className="sidebar__brand-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 8v32M38 8v32" stroke="currentColor" strokeWidth="2.5" />
            <path d="M10 14h11c9 0 17 7 17 16v4" stroke="currentColor" strokeWidth="2.5" />
            <path d="M10 34h11c9 0 17-7 17-16v-4" stroke="currentColor" strokeWidth="2.5" />
            <rect x="7" y="11" width="6" height="6" fill="currentColor" />
            <rect x="35" y="31" width="6" height="6" fill="currentColor" />
          </svg>
        </span>
        <span className="sidebar__brand-copy">
          <span>SiteFlow</span>
          <span className="sidebar__brand-kicker">Operator console</span>
        </span>
      </div>
      <NavigationGroup label="Yard" items={yardItems} />
      {projectItems.length > 0 ? <NavigationGroup label="This project" items={projectItems} /> : null}
    </aside>
  );
}
