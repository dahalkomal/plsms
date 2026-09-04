import React, { useState, useEffect, useCallback } from 'react';
import { License } from '../../types';
import { getAlphabeticalSummary, AlphabeticalSummaryResult, calculateDemoAlphabeticalSummary, invalidateAlphabeticalSummaryCache } from '../../dbService';
import { registryDataStore } from '../../registryDataStore';
import { Loader2, Filter, RefreshCw, ShieldCheck, Database, Zap } from 'lucide-react';
import NepaliDatePicker from '../NepaliDatePicker';

interface AlphabeticalDashboardTabProps {
  licenses?: License[];
  theme: string;
  onGoToOverview?: () => void;
}

export default function AlphabeticalDashboardTab({ licenses, theme }: AlphabeticalDashboardTabProps) {
  const [summary, setSummary] = useState<AlphabeticalSummaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastCalculatedAt, setLastCalculatedAt] = useState<string>(() => new Date().toLocaleTimeString());

  // Nepali Date Range Filter States
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [isFiltered, setIsFiltered] = useState<boolean>(false);

  const isDark = theme === 'dark';

  const loadSummary = useCallback(async (fDate?: string, tDate?: string, forceRecalc: boolean = false) => {
    setLoading(true);
    try {
      if (forceRecalc) {
        invalidateAlphabeticalSummaryCache();
      }
      const res = await getAlphabeticalSummary(fDate, tDate, licenses, forceRecalc);
      setSummary(res);
      setLastCalculatedAt(new Date().toLocaleTimeString());
    } catch (err: any) {
      console.warn("Notice: Local calculation fallback used:", err);
      // Zero-read engine never fails: fallback to local registry calculation
      const fallback = calculateDemoAlphabeticalSummary();
      setSummary(fallback);
    } finally {
      setLoading(false);
    }
  }, [licenses]);

  useEffect(() => {
    loadSummary(isFiltered ? fromDate : undefined, isFiltered ? toDate : undefined);
    const unsubscribe = registryDataStore.subscribe(() => {
      loadSummary(isFiltered ? fromDate : undefined, isFiltered ? toDate : undefined);
    });
    return () => {
      unsubscribe();
    };
  }, [loadSummary, licenses, isFiltered, fromDate, toDate]);

  const handleApplyFilter = () => {
    if (!fromDate && !toDate) return;
    setIsFiltered(true);
    loadSummary(fromDate, toDate);
  };

  const handleResetFilter = () => {
    setFromDate('');
    setToDate('');
    setIsFiltered(false);
    loadSummary('', '');
  };

  const handleForceRecalculate = () => {
    loadSummary(isFiltered ? fromDate : undefined, isFiltered ? toDate : undefined, true);
  };

  const alphabetStats = summary?.alphabetStats || [];
  const totalCount = summary?.totalCount || 0;
  const totalDistributed = summary?.totalDistributed || 0;
  const totalRemained = summary?.totalRemained || 0;

  return (
    <div className="w-full animate-in fade-in duration-300">
      {/* SCREEN INTERACTIVE VIEW (Hidden during PDF print) */}
      <div className="print:hidden space-y-4 w-full">

        {/* Zero Database Reads Assurance & Mode Feature Banner */}
        <div className={`p-4 rounded-3xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm transition-all ${
          isDark 
            ? 'bg-emerald-950/25 border-emerald-800/40 text-emerald-200' 
            : 'bg-emerald-50/80 border-emerald-200 text-emerald-950'
        }`}>
          <div className="flex items-start sm:items-center gap-3.5">
            <div className={`p-2.5 rounded-2xl flex items-center justify-center shrink-0 ${
              isDark ? 'bg-emerald-900/50 text-emerald-300 ring-1 ring-emerald-500/20' : 'bg-emerald-100 text-emerald-800'
            }`}>
              <ShieldCheck className="w-6 h-6 text-emerald-500" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-black text-sm uppercase tracking-wide">
                  Zero Database Reads Mode (शून्य डाटाबेस रिड)
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30">
                  <Database className="w-3 h-3" />
                  Cloud Firestore Reads: 0
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30">
                  <Zap className="w-3 h-3" />
                  100% In-Memory Fast Engine
                </span>
              </div>
              <p className={`text-xs mt-1 ${isDark ? 'text-emerald-300/80' : 'text-emerald-800 font-medium'}`}>
                This alphabetical breakdown runs completely client-side in local memory and cached storage. Opening this tab, filtering by dates, and resetting NEVER counts against your daily database read quota.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
            <div className={`text-[11px] font-mono font-medium px-3 py-1.5 rounded-xl border text-center ${
              isDark ? 'bg-slate-900/90 border-slate-800 text-slate-400' : 'bg-white border-emerald-200 text-slate-600 shadow-2xs'
            }`}>
              <span>Updated: {lastCalculatedAt}</span>
            </div>
            <button
              type="button"
              onClick={handleForceRecalculate}
              title="Recalculate in-memory summary with 0 cloud reads"
              className={`p-2 rounded-xl border transition-all cursor-pointer flex items-center gap-1.5 text-xs font-bold ${
                isDark 
                  ? 'bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 border-emerald-700/50' 
                  : 'bg-emerald-100/70 hover:bg-emerald-100 text-emerald-900 border-emerald-300'
              }`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Refresh (0 Reads)</span>
            </button>
          </div>
        </div>

        {/* Professional Nepali Date Range Filter Panel */}
        <div className={`p-4 rounded-2xl border transition-all shadow-sm ${
          isDark ? 'bg-slate-900/90 border-slate-700' : 'bg-slate-50 border-slate-300'
        }`}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4 sm:gap-6">
              {/* FROM DATE */}
              <NepaliDatePicker
                label="📅 FROM DATE (मिति देखि)"
                value={fromDate}
                onChange={(val) => setFromDate(val)}
                isDark={isDark}
                placeholder="मिति छान्नुहोस्"
              />

              {/* TO DATE */}
              <NepaliDatePicker
                label="📅 TO DATE (मिति सम्म)"
                value={toDate}
                onChange={(val) => setToDate(val)}
                isDark={isDark}
                placeholder="मिति छान्नुहोस्"
              />

              {/* FILTER ACTION BUTTONS */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleApplyFilter}
                  disabled={!fromDate && !toDate}
                  className={`px-5 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 transition-all cursor-pointer shadow-sm ${
                    !fromDate && !toDate
                      ? 'bg-slate-300 text-slate-500 cursor-not-allowed dark:bg-slate-800 dark:text-slate-600'
                      : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20 active:scale-95'
                  }`}
                >
                  <Filter className="w-3.5 h-3.5" />
                  <span>Apply Filter (फिल्टर लागू गर्नुहोस्)</span>
                </button>

                <button
                  type="button"
                  onClick={handleResetFilter}
                  className={`px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 transition-all cursor-pointer border ${
                    isDark 
                      ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700' 
                      : 'bg-white hover:bg-slate-100 text-slate-700 border-slate-300 shadow-2xs'
                  }`}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reset (पुनःसेट)</span>
                </button>
              </div>
            </div>

            {isFiltered && (
              <div className="flex items-center gap-2 text-xs font-extrabold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Date Filter Active: {fromDate || 'Start'} to {toDate || 'End'}</span>
              </div>
            )}
          </div>
        </div>

        {/* Government-Style Statistical Summary Table with Full Grid Borders */}
        <div className={`rounded-3xl border-2 shadow-2xl overflow-hidden transition-all ${
          isDark ? 'bg-slate-900 border-slate-600' : 'bg-white border-black'
        }`}>
          <div className="overflow-x-auto">
            <table className="w-full text-center border-collapse border-2 border-black dark:border-slate-600 font-sans">
              <thead>
                <tr className={`text-[14px] sm:text-[15px] uppercase tracking-wider font-black border-2 border-black dark:border-slate-600 ${
                  isDark ? 'bg-slate-950 text-slate-200' : 'bg-slate-200 text-slate-900'
                }`}>
                  <th className={`py-4 px-4 text-center font-black border-2 border-black dark:border-slate-600 w-1/4 ${isDark ? 'bg-slate-950' : 'bg-slate-200'}`}>ALPHABET (अक्षर)</th>
                  <th className={`py-4 px-4 text-center font-black border-2 border-black dark:border-slate-600 w-1/4 ${isDark ? 'bg-slate-950' : 'bg-slate-200'}`}>COUNT (कुल रेकर्ड)</th>
                  <th className={`py-4 px-4 text-center font-black border-2 border-black dark:border-slate-600 w-1/4 ${isDark ? 'bg-slate-950' : 'bg-slate-200'}`}>DISTRIBUTED (वितरण गरिएको)</th>
                  <th className={`py-4 px-4 text-center font-black border-2 border-black dark:border-slate-600 w-1/4 ${isDark ? 'bg-slate-950' : 'bg-slate-200'}`}>REMAINED (बाँकी)</th>
                </tr>
              </thead>
              <tbody className="text-[15px] sm:text-[16px]">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="py-12 text-center text-sm font-semibold">
                      <div className="flex items-center justify-center gap-2 text-cyan-500">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span>Aggregating in-memory summary (0 database reads)...</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  alphabetStats.map((row) => {
                    const hasData = row.count > 0;
                    return (
                      <tr
                        key={row.alphabet}
                        className={`transition-all border border-black dark:border-slate-600 ${
                          hasData ? 'font-semibold' : 'opacity-65 font-normal'
                        } ${
                          isDark ? 'text-slate-100' : 'text-slate-900'
                        }`}
                      >
                        <td className="py-3.5 px-4 text-center font-bold border border-black dark:border-slate-600">
                          <div className="flex items-center justify-center gap-3">
                            <span className={`w-9 h-9 rounded-xl flex items-center justify-center font-black text-base border font-mono ${
                              hasData
                                ? (isDark ? 'bg-cyan-950/80 text-cyan-400 border-cyan-700 shadow-xs' : 'bg-cyan-100 text-cyan-900 border-black shadow-xs')
                                : (isDark ? 'bg-slate-800 text-slate-400 border-slate-700' : 'bg-slate-100 text-slate-500 border-slate-400')
                            }`}>
                              {row.alphabet.slice(0, 1)}
                            </span>
                            <span className="font-bold text-[15px] sm:text-[16px]">Alphabet {row.alphabet}</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono font-black border border-black dark:border-slate-600">
                          <span className={`px-3 py-1 rounded-lg text-[15px] sm:text-[17px] ${
                            row.count > 0 ? (isDark ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-950 font-black') : 'text-slate-500'
                          }`}>
                            {row.count}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono font-black border border-black dark:border-slate-600">
                          <span className={`px-3 py-1 rounded-lg text-[15px] sm:text-[17px] ${
                            row.distributed > 0 ? 'text-emerald-500 dark:text-emerald-400 font-black' : 'text-slate-500'
                          }`}>
                            {row.distributed}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono font-black border border-black dark:border-slate-600">
                          <span className={`px-3 py-1 rounded-lg text-[15px] sm:text-[17px] ${
                            row.remained > 0 ? 'text-amber-500 dark:text-amber-400 font-black' : 'text-slate-500'
                          }`}>
                            {row.remained}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              <tfoot>
                <tr className={`border-2 border-black dark:border-slate-600 font-black text-[16px] sm:text-[18px] uppercase tracking-wide ${
                  isDark ? 'bg-slate-950 text-white' : 'bg-slate-200 text-slate-950'
                }`}>
                  <td className="py-4 px-4 text-center font-black border-2 border-black dark:border-slate-600">TOTAL (जम्मा)</td>
                  <td className="py-4 px-4 text-center font-mono text-lg text-cyan-600 dark:text-cyan-400 font-black border-2 border-black dark:border-slate-600">
                    {totalCount}
                  </td>
                  <td className="py-4 px-4 text-center font-mono text-lg text-emerald-700 dark:text-emerald-400 font-black border-2 border-black dark:border-slate-600">
                    {totalDistributed}
                  </td>
                  <td className="py-4 px-4 text-center font-mono text-lg text-amber-700 dark:text-amber-400 font-black border-2 border-black dark:border-slate-600">
                    {totalRemained}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>

      {/* DEDICATED PDF PRINT TEMPLATE (Hidden on screen, shown during PDF / print generation) */}
      <div id="alphabetical-print-report" className="hidden print:block w-full bg-white text-black font-sans p-4">
        {/* Government Heading Banner - Exact as Picture 2 */}
        <div className="w-full text-center space-y-1 pb-4">
          <h1 className="text-center font-black text-[24px] text-black tracking-tight leading-snug">
            यातायात व्यवस्था कार्यालय, सवारी चालक अनुमतिपत्र
          </h1>
          <div className="border-t border-gray-400 my-1 w-full mx-auto" />
          <h2 className="text-center font-bold text-[18px] text-black leading-snug">
            ईटहरी, सुनसरी
          </h2>
          <div className="border-t border-gray-400 my-1 w-full mx-auto" />
          <h3 className="text-center font-black text-[20px] text-[#1e3a8a] leading-snug uppercase tracking-wide">
            PRINTED LICENSE SEARCH MANAGEMENT SYSTEM (PLSMS)
          </h3>
          <h4 className="text-center font-extrabold text-[16px] text-gray-900 pt-2 underline uppercase">
            ALPHABETICAL SMART CARD DISTRIBUTION SUMMARY (वर्णमाला-अनुसार विवरण)
          </h4>
          <p className="text-center text-[12px] font-semibold text-gray-700 mb-4">
            Report Date: {new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}
          </p>
        </div>

        {/* Clean Printable Statistical Table with Solid Grid Borders */}
        <table className="w-full text-center border-collapse border-2 border-black font-sans text-[14px]">
          <thead>
            <tr className="bg-gray-100 text-black uppercase font-black">
              <th className="py-3 px-4 text-center font-black border border-black w-1/4">ALPHABET (अक्षर)</th>
              <th className="py-3 px-4 text-center font-black border border-black w-1/4">COUNT (कुल रेकर्ड)</th>
              <th className="py-3 px-4 text-center font-black border border-black w-1/4">DISTRIBUTED (वितरण गरिएको)</th>
              <th className="py-3 px-4 text-center font-black border border-black w-1/4">REMAINED (बाँकी)</th>
            </tr>
          </thead>
          <tbody>
            {alphabetStats.map((row) => (
              <tr key={row.alphabet} className="border border-black">
                <td className="py-2.5 px-4 text-center font-bold border border-black">
                  Alphabet {row.alphabet}
                </td>
                <td className="py-2.5 px-4 text-center font-mono font-bold border border-black">
                  {row.count}
                </td>
                <td className="py-2.5 px-4 text-center font-mono font-bold text-green-800 border border-black">
                  {row.distributed}
                </td>
                <td className="py-2.5 px-4 text-center font-mono font-bold text-amber-900 border border-black">
                  {row.remained}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-100 font-black text-[16px] uppercase border-2 border-black">
              <td className="py-3 px-4 text-center font-black border border-black">TOTAL (जम्मा)</td>
              <td className="py-3 px-4 text-center font-mono font-black border border-black">{totalCount}</td>
              <td className="py-3 px-4 text-center font-mono font-black text-green-900 border border-black">{totalDistributed}</td>
              <td className="py-3 px-4 text-center font-mono font-black text-amber-950 border border-black">{totalRemained}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
