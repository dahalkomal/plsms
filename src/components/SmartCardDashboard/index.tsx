import React, { useState } from 'react';
import OverviewDashboardTab from './OverviewDashboardTab';
import AlphabeticalDashboardTab from './AlphabeticalDashboardTab';
import { License } from '../../types';

interface SmartCardDashboardProps {
  licenses: License[];
  theme?: string;
  children: React.ReactNode;
  activeTab?: 'overview' | 'alphabetical';
  onChangeTab?: (tab: 'overview' | 'alphabetical') => void;
}

export default function SmartCardDashboard({ 
  licenses, 
  theme = 'dark', 
  children,
  activeTab: controlledTab,
  onChangeTab
}: SmartCardDashboardProps) {
  const [localTab, setLocalTab] = useState<'overview' | 'alphabetical'>('overview');
  const isDark = theme === 'dark';

  const activeTab = controlledTab !== undefined ? controlledTab : localTab;
  const setActiveTab = (tab: 'overview' | 'alphabetical') => {
    if (onChangeTab) {
      onChangeTab(tab);
    } else {
      setLocalTab(tab);
    }
  };

  return (
    <div className="space-y-6 max-w-full w-full mx-auto font-sans animate-in fade-in duration-300">
      {/* Top Tab Navigation Header */}
      <div className={`p-2 rounded-2xl border flex flex-wrap items-center gap-2 shadow-sm ${
        isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-100/90 border-slate-200'
      }`}>
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`px-5 py-2.5 rounded-xl text-xs font-black tracking-wider uppercase transition-all flex items-center gap-2 cursor-pointer ${
            activeTab === 'overview'
              ? (isDark ? 'bg-cyan-600 text-white shadow-md shadow-cyan-900/30' : 'bg-cyan-600 text-white shadow-md shadow-cyan-600/30')
              : (isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60' : 'text-slate-600 hover:text-slate-900 hover:bg-white/60')
          }`}
        >
          <span className="text-base">📊</span>
          OVERVIEW DASHBOARD
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('alphabetical')}
          className={`px-5 py-2.5 rounded-xl text-xs font-black tracking-wider uppercase transition-all flex items-center gap-2 cursor-pointer ${
            activeTab === 'alphabetical'
              ? (isDark ? 'bg-cyan-600 text-white shadow-md shadow-cyan-900/30' : 'bg-cyan-600 text-white shadow-md shadow-cyan-600/30')
              : (isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60' : 'text-slate-600 hover:text-slate-900 hover:bg-white/60')
          }`}
        >
          <span className="text-base">🔤</span>
          ALPHABETICAL DASHBOARD
        </button>
      </div>

      {/* Tab Content Rendering */}
      {activeTab === 'overview' ? (
        <OverviewDashboardTab>
          {children}
        </OverviewDashboardTab>
      ) : (
        <AlphabeticalDashboardTab 
          licenses={licenses} 
          theme={theme} 
          onGoToOverview={() => setActiveTab('overview')}
        />
      )}
    </div>
  );
}
