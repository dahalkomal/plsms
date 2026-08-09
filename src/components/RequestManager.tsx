import React, { useState, useEffect } from 'react';
import { auth } from '../firebase';
import { 
  getAllCollectionRequests, 
  updateCollectionRequestStatus, 
  getLicenseById, 
  createOrUpdateLicense,
  getAllUserRoles,
  resolveStaffName
} from '../dbService';
import { CollectionRequest, License } from '../types';
import { Calendar, User, Phone, Check, X, Search, FileText, CheckSquare, Clock, HelpCircle, CornerDownRight } from 'lucide-react';
import { convertADToBS } from '../utils/dateConverter';

export default function RequestManager({ theme = 'dark' }: { theme?: 'light' | 'dark' }) {
  const [requests, setRequests] = useState<CollectionRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [usersRoles, setUsersRoles] = useState<any[]>([]);

  useEffect(() => {
    fetchRequests();
    async function loadRoles() {
      try {
        const uList = await getAllUserRoles();
        setUsersRoles(uList);
      } catch (err) {}
    }
    loadRoles();
  }, []);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const list = await getAllCollectionRequests();
      setRequests(list);
    } catch (err: any) {
      console.error("Failed to query collection requests: ", err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async (request: CollectionRequest, newStatus: 'approved' | 'completed' | 'cancelled') => {
    setActionLoading(request.id);
    const staffEmail = auth.currentUser?.email || 'staff@plsms.gov.bd';
    try {
      // 1. Update the request status
      await updateCollectionRequestStatus(request.id, newStatus);

      // 2. If completing, transition matched License to 'distributed' immediately
      if (newStatus === 'completed') {
        const licData = await getLicenseById(request.licenseId);
        
        if (licData) {
          const currentLogs = licData.logs || [];
          const newLog = {
            timestamp: new Date().toISOString(),
            action: 'DISTRIBUTED_VIA_REQUEST',
            user: staffEmail,
            details: `Distributed to scheduled recipient: ${request.receiverName} (Phone: ${request.phoneNumber})`
          };

          const resolvedName = resolveStaffName(staffEmail, usersRoles);

          await createOrUpdateLicense(request.licenseId, {
            ...licData,
            status: 'distributed',
            receivedBy: request.receiverName,
            updatedAt: new Date().toISOString(),
            updatedBy: staffEmail,
            distributedByStaffName: resolvedName,
            logs: [...currentLogs, newLog]
          });
        }
      }

      fetchRequests();
    } catch (err: any) {
      alert("Failed to modify request status: " + err.message);
    } finally {
      setActionLoading(null);
    }
  };

  // Filter lists
  const filteredRequests = requests.filter(req => {
    const matchesSearch = 
      req.licenseHolderName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      req.licenseNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      req.receiverName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      req.phoneNumber.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (statusFilter === 'all') return matchesSearch;
    return matchesSearch && req.status === statusFilter;
  });

  return (
    <div className="space-y-6 max-w-full mx-auto font-sans">
      <div className={`border-b pb-5 transition-colors ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
        <h2 className={`text-xl font-bold tracking-tight flex items-center gap-2 ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
          <Calendar className="w-5 h-5 text-cyan-600 dark:text-cyan-400 animate-pulse" />
          Scheduled Collection Requests (Section 6)
        </h2>
        <p className={`text-sm mt-1 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>
          Review, approve, and complete driving license pick-up appointments scheduled by citizens.
        </p>
      </div>

      {/* Filters Bar */}
      <div className={`flex flex-col sm:flex-row gap-4 justify-between items-center p-4 rounded-2xl border transition-all ${
        theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}>
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3.5 top-3 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search holder name, phone, DL..."
            className={`w-full pl-10 pr-4 py-2 rounded-xl text-xs border focus:outline-hidden transition-all ${
              theme === 'dark' 
                ? 'bg-slate-950 border-slate-700 text-white placeholder-slate-550' 
                : 'bg-slate-50 border-slate-250 text-slate-900 placeholder-slate-400'
            }`}
          />
        </div>

        <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end">
          <span className={`text-xs font-bold uppercase tracking-wider ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>Filter Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={`px-3 py-1.5 border rounded-xl text-xs focus:outline-hidden focus:border-cyan-500 transition-all ${
              theme === 'dark' 
                ? 'bg-slate-950 border-slate-700 text-slate-200' 
                : 'bg-white border-[#ccc] border text-slate-705 text-slate-700'
            }`}
          >
            <option value="all">All Requests</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-500 text-xs">Querying scheduled request queues...</div>
      ) : filteredRequests.length === 0 ? (
        <div className={`py-16 text-center rounded-3xl border border-dashed text-xs transition-all ${
          theme === 'dark' ? 'bg-slate-950/40 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-505 text-slate-500'
        }`}>
          No appointments found matching filtered specifications.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-fade-in">
          {filteredRequests.map((req) => {
            const isDark = theme === 'dark';
            let badgeStyle = isDark 
              ? 'bg-amber-950/30 text-amber-400 border-amber-900/40' 
              : 'bg-amber-50 text-amber-800 border-amber-200';
            
            if (req.status === 'approved') {
              badgeStyle = isDark 
                ? 'bg-cyan-950/30 text-cyan-400 border-cyan-900/40' 
                : 'bg-cyan-50 text-cyan-705 text-cyan-700 border-cyan-200';
            } else if (req.status === 'completed') {
              badgeStyle = isDark 
                ? 'bg-emerald-950/30 text-emerald-400 border-emerald-900/40' 
                : 'bg-emerald-50 text-emerald-800 border-emerald-200';
            } else if (req.status === 'cancelled') {
              badgeStyle = isDark 
                ? 'bg-red-950/30 text-red-400 border-red-900/40' 
                : 'bg-red-50 text-red-700 border-red-200';
            }

            return (
              <div 
                key={req.id} 
                className={`border rounded-2xl p-5 hover:shadow-2xl transition-all relative ${
                  isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-md'
                } ${
                  req.status === 'completed' 
                    ? 'border-emerald-500/20 opacity-75' 
                    : req.status === 'cancelled' 
                      ? 'border-slate-400/20 opacity-60' 
                      : ''
                }`}
              >
                <div className={`flex items-start justify-between gap-4 mb-3 pb-3 border-b ${
                  isDark ? 'border-slate-850' : 'border-slate-100'
                }`}>
                  <span className={`px-2 py-0.5 rounded-md text-[9px] font-bold uppercase border tracking-wider h-fit ${badgeStyle}`}>
                    {req.status}
                  </span>
                  <span className={`text-[10px] font-mono italic ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Submitted: {convertADToBS(req.createdAt)}
                  </span>
                </div>

                <div className={`space-y-2.5 text-xs ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  <div>
                    <span className="text-[10px] text-slate-500 block font-bold uppercase">Driving License</span>
                    <span className={`font-bold block text-sm ${isDark ? 'text-white' : 'text-slate-900'}`}>{req.licenseHolderName}</span>
                    <span className={`font-mono text-[11px] block mt-0.5 ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>{req.licenseNumber}</span>
                  </div>

                  <div className={`grid grid-cols-2 gap-2 p-2.5 rounded-xl border transition-all ${
                    isDark ? 'bg-slate-950 border-slate-850' : 'bg-slate-50 border-slate-200'
                  }`}>
                    <div>
                      <span className="text-[9px] text-slate-500 block">RECEIVER NAME</span>
                      <span className={`font-bold break-words ${isDark ? 'text-white' : 'text-slate-800'}`}>{req.receiverName}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-505 text-slate-500 block">VISIT DAY</span>
                      <span className={`font-bold ${isDark ? 'text-cyan-305 text-cyan-300' : 'text-cyan-700'}`}>{req.visitDay}</span>
                    </div>
                    <div className={`col-span-2 pt-1.5 mt-1 border-t ${isDark ? 'border-slate-850' : 'border-slate-100'}`}>
                      <span className="text-[9px] text-slate-500 block">PHONE NUMBER</span>
                      <span className={`font-bold ${isDark ? 'text-slate-300' : 'text-slate-705 text-slate-700'}`}>{req.phoneNumber}</span>
                    </div>
                  </div>

                   {req.remarks && (
                    <div className={`text-[11px] p-2 rounded-lg border transition-all ${
                      isDark ? 'bg-[#0f172a]/50 border-slate-850 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}>
                      <span className="font-bold text-[9px] block uppercase tracking-wider text-slate-500 mb-0.5">Applicant Remarks</span>
                      "{req.remarks}"
                    </div>
                  )}
                </div>

                {/* Staff Controller Actions (Only shown if pending or approved) */}
                {auth.currentUser && (req.status === 'pending' || req.status === 'approved') && (
                  <div className={`mt-4 pt-3 border-t flex items-center justify-end gap-2 ${
                    isDark ? 'border-slate-850' : 'border-slate-100'
                  }`}>
                    {actionLoading === req.id ? (
                      <span className="text-[10px] text-slate-500 animate-pulse">Running action...</span>
                    ) : (
                      <>
                        <button
                          onClick={() => handleUpdateStatus(req, 'cancelled')}
                          className={`flex items-center gap-1 px-2.5 py-1.5 border rounded-lg text-[10px] font-bold uppercase transition-all cursor-pointer ${
                            isDark 
                              ? 'border-red-900/40 text-red-500 bg-red-950/30 hover:bg-red-900/30' 
                              : 'border-red-200 text-red-700 bg-red-50 hover:bg-red-100 shadow-xs'
                          }`}
                        >
                          <X className="w-3.5 h-3.5" />
                          Decline
                        </button>
                        
                        {req.status === 'pending' && (
                          <button
                            onClick={() => handleUpdateStatus(req, 'approved')}
                            className={`flex items-center gap-1 px-3 py-1.5 border rounded-lg text-[10px] font-bold uppercase transition-all cursor-pointer ${
                              isDark 
                                ? 'bg-cyan-950/30 text-cyan-404 text-cyan-400 border-cyan-900/30 hover:bg-cyan-900/40' 
                                : 'bg-cyan-50 text-cyan-705 text-cyan-700 border-cyan-200 hover:bg-cyan-100'
                            }`}
                          >
                            <Clock className="w-3.5 h-3.5" />
                            Approve Pickup
                          </button>
                        )}

                        <button
                          onClick={() => handleUpdateStatus(req, 'completed')}
                          className="flex items-center gap-1 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-[10px] font-bold uppercase tracking-wide transition-all shadow-md active:scale-95 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Complete Picker & Distribute
                        </button>
                      </>
                    )}
                  </div>
                )}
                
                {req.status === 'completed' && (
                  <div className={`mt-2.5 flex items-center gap-1 text-[10px] font-bold py-1.5 px-2.5 rounded-lg border w-fit ${
                    isDark 
                      ? 'text-emerald-400 bg-emerald-950/20 border-emerald-900/30' 
                      : 'text-emerald-800 bg-emerald-50 border-emerald-200'
                  }`}>
                    <CheckSquare className="w-3.5 h-3.5" />
                    Distributed & Handed Over
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
