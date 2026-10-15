import React from 'react';
import { useLang } from '../../i18n';
import { LucideIcon } from '../../ui';

interface Tab {
  id: string;
  label: string;
  icon: string;
}

interface OptionsSidebarProps {
  active: string;
  onChange: (id: string) => void;
}

export function OptionsSidebar({ active, onChange }: OptionsSidebarProps) {
  const { t } = useLang();

  const tabs: Tab[] = [
    { id: 'general',   label: t('options.tabs.general'),  icon: 'Home' },
    { id: 'providers', label: t('options.tabs.llm'),      icon: 'Cpu' },
    { id: 'memory',    label: t('options.tabs.memory'),   icon: 'BrainCircuit' },
    { id: 'skills',    label: t('options.tabs.skills'),   icon: 'Workflow' },
    { id: 'profiles',  label: t('options.tabs.profiles'), icon: 'Globe' },
    { id: 'help',      label: t('options.tabs.help'),     icon: 'BookOpen' },
  ];

  return (
    <aside style={{
      width: 240, flex: '0 0 240px', minHeight: '100vh',
      background: 'var(--surface)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', padding: '22px 14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px 24px' }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8,
          background: 'linear-gradient(135deg, var(--primary), var(--primary-dim))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 8px oklch(56% 0.19 296 / 0.25)',
        }}>
          <svg width="13" height="13" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 6L4.5 9.4641V2.5359L10 6Z" fill="white" />
          </svg>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: -0.3, color: 'var(--text)' }}>DomMotion</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>v0.4.0</span>
        </div>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {tabs.map((tab) => {
          const on = tab.id === active;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              style={{
                height: 38, padding: '0 12px', borderRadius: 10, border: 0, cursor: 'pointer',
                background: on ? 'var(--primary-soft)' : 'transparent',
                color: on ? 'var(--primary)' : 'var(--text)',
                fontWeight: on ? 700 : 600, fontSize: 13, fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                transition: 'background .12s, color .12s',
              }}
              onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
            >
              <LucideIcon name={tab.icon} size={17} color={on ? 'var(--primary)' : 'var(--text-muted)'} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <div style={{ marginTop: 'auto', padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>
          extension v0.4.0
        </div>
      </div>
    </aside>
  );
}
