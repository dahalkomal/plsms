import React from 'react';
import { LicenseLog } from '../types';
import { History, Clock, User, MessageSquare, Tag } from 'lucide-react';
import { convertADToBS } from '../utils/dateConverter';

interface LicenseHistoryProps {
  logs: LicenseLog[];
}

export default function LicenseHistory({ logs }: LicenseHistoryProps) {
  if (!logs || logs.length === 0) {
    return (
      <div className="text-center py-8 text-xs text-slate-400 font-sans">
        No administrative history logged for this ledger item.
      </div>
    );
  }

  return (
    <div className="space-y-4 max-h-[380px] overflow-y-auto pr-2 font-sans">
      <div className="flex items-center gap-1.5 border-b border-slate-100 pb-2 mb-3">
        <History className="w-4 h-4 text-indigo-500" />
        <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">Permanent Ledger Audit Trail</span>
      </div>

      <div className="relative border-l-2 border-slate-100 ml-3.5 pl-5 space-y-6">
        {logs.map((log, index) => {
          let statusColor = 'bg-slate-100 text-slate-700';
          if (log.action.includes('DISTRIBUTED')) statusColor = 'bg-green-100 text-green-700';
          else if (log.action.includes('MISSING')) statusColor = 'bg-red-100 text-red-700';
          else if (log.action.includes('FOUND')) statusColor = 'bg-indigo-100 text-indigo-700';
          else if (log.action.includes('IMPORT')) statusColor = 'bg-emerald-100 text-emerald-700';

          return (
            <div key={index} className="relative group">
              {/* Timeline marker node */}
              <div className="absolute -left-[27px] top-1 w-3 h-3 rounded-full bg-slate-250 ring-4 ring-white group-hover:bg-indigo-500 transition-colors" />

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`px-2 py-0.5 rounded-sm text-[9px] font-bold uppercase tracking-wider ${statusColor}`}>
                    {log.action}
                  </span>
                  
                  <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {convertADToBS(log.timestamp)}
                  </span>
                </div>

                <p className="text-slate-600 text-xs leading-normal font-sans italic">
                  "{log.details}"
                </p>

                <div className="text-[10px] text-slate-400 flex items-center gap-1">
                  <User className="w-3 h-3 text-slate-300" />
                  <span>Auditor ID: <span className="font-mono text-slate-500">{log.user}</span></span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
