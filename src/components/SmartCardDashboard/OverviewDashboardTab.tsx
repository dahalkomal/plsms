import React from 'react';

interface OverviewDashboardTabProps {
  children: React.ReactNode;
}

export default function OverviewDashboardTab({ children }: OverviewDashboardTabProps) {
  return (
    <div className="w-full animate-in fade-in duration-200">
      {children}
    </div>
  );
}
