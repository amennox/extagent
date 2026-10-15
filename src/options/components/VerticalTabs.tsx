import React, { useState } from 'react';
import { useLang } from '../../i18n';
import { FunctionMapping, ModelProfile } from '../../models/providers/types';
import { OptionsSidebar } from './OptionsSidebar';
import { PageHeader } from './PageHeader';
import { DomainProfilesTab } from './tabs/DomainProfilesTab';
import { GeneralTab } from './tabs/GeneralTab';
import { HelpTab } from './tabs/HelpTab';
import { MemoryTab } from './tabs/MemoryTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { SkillsTab } from './tabs/SkillsTab';

interface VerticalTabsProps {
  openaiCompatibleApiKey: string;
  setOpenaiCompatibleApiKey: (key: string) => void;
  openaiCompatibleBaseUrl: string;
  setOpenaiCompatibleBaseUrl: (url: string) => void;
  openaiCompatibleModelId: string;
  setOpenaiCompatibleModelId: (id: string) => void;
  profiles: ModelProfile[];
  setProfiles: (profiles: ModelProfile[]) => void;
  defaultProfileId: string;
  setDefaultProfileId: (id: string) => void;
  functionMappings: FunctionMapping[];
  setFunctionMappings: (mappings: FunctionMapping[]) => void;
  isSaving: boolean;
  saveStatus: string;
  handleSave: () => void;
}

export function VerticalTabs(props: VerticalTabsProps) {
  const [activeTab, setActiveTab] = useState('general');
  const { t } = useLang();

  const titles: Record<string, { title: string; subtitle: string }> = {
    general:   { title: t('options.tabs.general'),  subtitle: t('options.subtitles.general') },
    providers: { title: t('options.tabs.llm'),       subtitle: t('options.subtitles.providers') },
    memory:    { title: t('options.tabs.memory'),    subtitle: t('options.subtitles.memory') },
    skills:    { title: t('options.tabs.skills'),    subtitle: t('options.subtitles.skills') },
    profiles:  { title: t('options.tabs.profiles'),  subtitle: t('options.subtitles.profiles') },
    help:      { title: t('options.tabs.help'),      subtitle: t('options.subtitles.help') },
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralTab />;
      case 'providers':
        return (
          <ProvidersTab
            openaiCompatibleApiKey={props.openaiCompatibleApiKey}
            setOpenaiCompatibleApiKey={props.setOpenaiCompatibleApiKey}
            openaiCompatibleBaseUrl={props.openaiCompatibleBaseUrl}
            setOpenaiCompatibleBaseUrl={props.setOpenaiCompatibleBaseUrl}
            openaiCompatibleModelId={props.openaiCompatibleModelId}
            setOpenaiCompatibleModelId={props.setOpenaiCompatibleModelId}
            profiles={props.profiles}
            setProfiles={props.setProfiles}
            defaultProfileId={props.defaultProfileId}
            setDefaultProfileId={props.setDefaultProfileId}
            functionMappings={props.functionMappings}
            setFunctionMappings={props.setFunctionMappings}
            isSaving={props.isSaving}
            saveStatus={props.saveStatus}
            handleSave={props.handleSave}
          />
        );
      case 'memory':
        return <MemoryTab />;
      case 'skills':
        return <SkillsTab />;
      case 'profiles':
        return <DomainProfilesTab />;
      case 'help':
        return <HelpTab />;
      default:
        return <GeneralTab />;
    }
  };

  const cur = titles[activeTab] ?? titles.general;

  return (
    <div data-theme="dommotion" style={{
      display: 'flex', minHeight: '100vh', background: 'var(--bg)',
      fontFamily: 'var(--font-sans)',
    }}>
      <OptionsSidebar active={activeTab} onChange={setActiveTab} />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <PageHeader title={cur.title} subtitle={cur.subtitle} />
        <div className="ia-scroll" style={{ flex: 1, overflowY: 'auto', padding: '28px 32px 48px' }}>
          {renderTabContent()}
        </div>
      </main>
    </div>
  );
}
