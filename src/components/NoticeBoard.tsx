import React, { useState, useEffect, useRef } from 'react';
import { auth } from '../firebase';
import { 
  getAllNotices, 
  addNotice, 
  updateNoticeActiveStatus, 
  deleteNotice,
  updateNotice
} from '../dbService';
import { Notice } from '../types';
import { Plus, Trash, CheckCircle2, XCircle, FilePlus, Volume2, Calendar, ClipboardList, ExternalLink, Pencil, Upload, Paperclip, Download, File, Check, X, Bold, Italic, Type, Palette, Highlighter, Eye, EyeOff, ChevronDown } from 'lucide-react';
import { convertADToBS } from '../utils/dateConverter';

interface NoticeBoardProps {
  isAdmin: boolean;
  isSuperuser?: boolean;
  theme?: 'light' | 'dark';
  currentUserDisplayName?: string;
}

interface NoticeRichEditorProps {
  id: string;
  value: string;
  onChange: (val: string) => void;
  theme: 'light' | 'dark';
  placeholder?: string;
}

const NoticeRichEditor: React.FC<NoticeRichEditorProps> = ({
  id,
  value,
  onChange,
  theme,
  placeholder = "Provide explicit operational info: batch parameters, collection time windows, and desk numbers..."
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // Set innerHTML once on mount or when the value is cleared/reset from outside
  useEffect(() => {
    if (ref.current) {
      if (ref.current.innerHTML !== value) {
        ref.current.innerHTML = value;
      }
    }
  }, [value]);

  const handleInput = () => {
    if (ref.current) {
      onChange(ref.current.innerHTML);
    }
  };

  return (
    <div className="relative">
      <style>{`
        .custom-rich-editor:empty::before {
          content: attr(data-placeholder);
          color: #94a3b8;
          pointer-events: none;
          display: block;
        }
        .custom-rich-editor mark {
          background-color: #fef08a !important;
          color: #0f172a !important;
          padding: 2px 4px;
          border-radius: 4px;
        }
      `}</style>
      <div
        ref={ref}
        id={id}
        contentEditable
        onInput={handleInput}
        data-placeholder={placeholder}
        className={`custom-rich-editor w-full min-h-[160px] max-h-[350px] overflow-y-auto px-4 py-3.5 border-b border-x rounded-b-xl text-sm transition-colors outline-hidden focus:outline-hidden break-words leading-relaxed ${
          theme === 'dark' 
            ? 'bg-[#0b0f19] border-slate-700/80 text-white focus:border-cyan-500' 
            : 'bg-white border-slate-200 text-slate-prev-border text-slate-900 focus:border-cyan-600 shadow-inner border-slate-250'
        }`}
        style={{ outline: 'none' }}
      />
    </div>
  );
};

const AVAILABLE_FONTS = [
  { name: 'Default Sans', value: 'Inter, system-ui, sans-serif' },
  { name: 'Elegant Serif', value: "'Playfair Display', Georgia, serif" },
  { name: 'Modern Mono', value: "'JetBrains Mono', Fira Code, monospace" },
  { name: 'Space Grotesk', value: "'Space Grotesk', Outfit, sans-serif" },
  { name: 'Friendly Cursive', value: "'Comic Sans MS', cursive" }
];

const AVAILABLE_COLORS = [
  { name: 'Cyan Accent', value: '#06b6d4' },
  { name: 'Emerald Green', value: '#10b981' },
  { name: 'Amber Yellow', value: '#f59e0b' },
  { name: 'Crimson Red', value: '#ef4444' },
  { name: 'Electric Purple', value: '#8b5cf6' },
  { name: 'Sky Blue', value: '#3b82f6' },
  { name: 'Soft Orange', value: '#f97316' },
  { name: 'White / Light', value: '#f1f5f9' },
  { name: 'Charcoal / Dark', value: '#1e293b' }
];

const AVAILABLE_BGS = [
  { name: 'Yellow Highlight', value: '#fef08a' },
  { name: 'Green Highlight', value: '#a7f3d0' },
  { name: 'Cyan Highlight', value: '#a5f3fc' },
  { name: 'Red Highlight', value: '#fecaca' },
  { name: 'Purple Highlight', value: '#ddd6fe' },
  { name: 'Gray Highlight', value: '#cbd5e1' }
];

const renderNoticeHTML = (text: string, currentTheme: string = 'dark') => {
  if (!text) return { __html: '' };

  const linkColor = currentTheme === 'light' ? '#2563eb' : '#06b6d4';

  // Step 1: Strip dangerous scripts & events
  let clean = text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');

  // Step 2: Auto link URLs (only those not inside standard href configurations)
  clean = clean.replace(/(?<!href=["'])(https?:\/\/[^\s<]+)/g, (match) => {
    let cleanUrl = match;
    let trailingPunctuation = '';
    const trailingMatch = match.match(/([.,;:!)]+)$/);
    if (trailingMatch) {
      trailingPunctuation = trailingMatch[1];
      cleanUrl = match.slice(0, -trailingPunctuation.length);
    }
    return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color: ${linkColor}; text-decoration: underline; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 2px;">${cleanUrl}</a>${trailingPunctuation}`;
  });

  // Step 3: Convert newlines to br tags only if there are no HTML tags
  const hasHTML = /<[a-z][\s\S]*>/i.test(text);
  if (!hasHTML) {
    clean = clean.replace(/\n/g, '<br/>');
  }

  return { __html: clean };
};

const resolveCreatorName = (email: string, createdByName?: string): string => {
  if (createdByName) return createdByName;
  if (!email) return 'Lead Administrator';
  const emailLower = email.toLowerCase();
  if (emailLower === 'dahalkomal@gmail.com') return 'Komal Dahal';

  const prefix = email.split('@')[0];
  return prefix
    .split(/[._-]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const renderContentWithLinks = (text: string, theme: 'light' | 'dark') => {
  if (!text) return null;
  // Regex to detect urls starting with http:// or https://
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  
  return parts.map((part, index) => {
    if (part.match(urlRegex)) {
      let cleanUrl = part;
      let trailingPunctuation = '';
      
      const trailingMatch = part.match(/([.,;:!)]+)$/);
      if (trailingMatch) {
        trailingPunctuation = trailingMatch[1];
        cleanUrl = part.slice(0, -trailingPunctuation.length);
      }
      
      return (
        <React.Fragment key={index}>
          <a
            href={cleanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-500 hover:text-cyan-400 underline font-semibold transition-colors duration-200 inline-flex items-center gap-0.5 break-all cursor-pointer"
            id={`link-${index}`}
          >
            {cleanUrl}
            <ExternalLink className="w-3.5 h-3.5 shrink-0 inline-block align-middle ml-0.5" />
          </a>
          {trailingPunctuation}
        </React.Fragment>
      );
    }
    return part;
  });
};

export default function NoticeBoard({ 
  isAdmin, 
  isSuperuser = false, 
  theme = 'dark',
  currentUserDisplayName 
}: NoticeBoardProps) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Create Notice State
  const [showAddForm, setShowAddForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // New Notice Attachment State
  const [attachmentUrl, setAttachmentUrl] = useState<string>('');
  const [attachmentName, setAttachmentName] = useState<string>('');

  // Editing notice state
  const [editingNoticeId, setEditingNoticeId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [editContent, setEditContent] = useState<string>('');
  const [editAttachmentUrl, setEditAttachmentUrl] = useState<string | null>(null);
  const [editAttachmentName, setEditAttachmentName] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState<boolean>(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Formatting & Menu state dropdowns
  const [createFontOpen, setCreateFontOpen] = useState(false);
  const [createColorOpen, setCreateColorOpen] = useState(false);
  const [createBgOpen, setCreateBgOpen] = useState(false);

  const [editFontOpen, setEditFontOpen] = useState(false);
  const [editColorOpen, setEditColorOpen] = useState(false);
  const [editBgOpen, setEditBgOpen] = useState(false);

  const handleDropdownToggle = (isEdit: boolean, menu: 'font' | 'color' | 'bg') => {
    if (isEdit) {
      setEditFontOpen(menu === 'font' ? !editFontOpen : false);
      setEditColorOpen(menu === 'color' ? !editColorOpen : false);
      setEditBgOpen(menu === 'bg' ? !editBgOpen : false);
    } else {
      setCreateFontOpen(menu === 'font' ? !createFontOpen : false);
      setCreateColorOpen(menu === 'color' ? !createColorOpen : false);
      setCreateBgOpen(menu === 'bg' ? !createBgOpen : false);
    }
  };

  const closeAllDropdowns = () => {
    setCreateFontOpen(false);
    setCreateColorOpen(false);
    setCreateBgOpen(false);
    setEditFontOpen(false);
    setEditColorOpen(false);
    setEditBgOpen(false);
  };

  const toggleDropdown = (e: React.MouseEvent, isEdit: boolean, menu: 'font' | 'color' | 'bg') => {
    e.stopPropagation();
    e.preventDefault();
    handleDropdownToggle(isEdit, menu);
  };

  const executeFormattingCommand = (
    isEdit: boolean,
    command: string,
    value: string = ''
  ) => {
    // 1. Focus the editor first to ensure we have active focus inside it
    const editorId = isEdit ? `edit-editor-${editingNoticeId}` : 'create-editor';
    const editor = document.getElementById(editorId) as HTMLDivElement;
    if (editor) {
      editor.focus();
    }

    // 2. Execute command
    document.execCommand(command, false, value);

    // 3. Update React state immediately with the updated HTML content
    if (isEdit) {
      if (editor) {
        setEditContent(editor.innerHTML);
      }
    } else {
      if (editor) {
        setContent(editor.innerHTML);
      }
    }
  };

  useEffect(() => {
    const handleGlobalClick = () => {
      closeAllDropdowns();
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  const renderRichTextToolbar = (isEdit: boolean) => {
    const fontOpen = isEdit ? editFontOpen : createFontOpen;
    const colorOpen = isEdit ? editColorOpen : createColorOpen;
    const bgOpen = isEdit ? editBgOpen : createBgOpen;

    return (
      <div className={`relative flex flex-wrap items-center gap-2 p-2 border-t border-x rounded-t-xl transition-colors ${
        theme === 'dark' ? 'bg-[#0f172a] border-slate-700/80' : 'bg-slate-50 border-slate-200'
      }`}>
        <style>{`
          .font-option {
            padding: 6px 12px;
            font-size: 11px;
            cursor: pointer;
            transition: background-color 0.15s;
          }
          .font-option:hover {
            background-color: ${theme === 'dark' ? '#1e293b' : '#f1f5f9'};
          }
        `}</style>

        {/* 1. Font Style Dropdown */}
        <div className="relative">
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault(); // crucial to not lose content selection
            }}
            onClick={(e) => toggleDropdown(e, isEdit, 'font')}
            className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg border outline-none cursor-pointer transition-colors ${
              theme === 'dark' 
                ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800' 
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-xs'
            }`}
          >
            <Type className="w-3.5 h-3.5 text-cyan-500" />
            <span>Font Style</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>
          
          {fontOpen && (
            <div 
              className={`absolute top-full left-0 z-50 mt-1 min-w-[160px] py-1 border rounded-lg shadow-xl ${
                theme === 'dark' ? 'bg-[#0b0f19] border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-800'
              }`}
              onMouseDown={(e) => e.preventDefault()} // keep selection
            >
              {AVAILABLE_FONTS.map(f => (
                <div
                  key={f.name}
                  onClick={() => {
                    executeFormattingCommand(isEdit, 'fontName', f.value);
                    closeAllDropdowns();
                  }}
                  className="font-option font-medium"
                  style={{ fontFamily: f.value }}
                >
                  {f.name}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 2. Bold Button */}
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => executeFormattingCommand(isEdit, 'bold')}
          className={`p-1.5 rounded-lg border transition-all hover:scale-105 active:scale-95 cursor-pointer flex items-center justify-center ${
            theme === 'dark' 
              ? 'bg-slate-900 border-slate-700 hover:bg-slate-800 text-slate-300 hover:text-white' 
              : 'bg-white border-slate-200 hover:bg-slate-100 text-slate-750 hover:text-slate-900 shadow-xs'
          }`}
          title="Bold (Ctrl+B)"
        >
          <Bold className="w-3.5 h-3.5 font-extrabold" />
        </button>

        {/* 3. Italic Button */}
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => executeFormattingCommand(isEdit, 'italic')}
          className={`p-1.5 rounded-lg border transition-all hover:scale-105 active:scale-95 cursor-pointer flex items-center justify-center ${
            theme === 'dark' 
              ? 'bg-slate-900 border-slate-700 hover:bg-slate-800 text-slate-300 hover:text-white' 
              : 'bg-white border-slate-200 hover:bg-slate-100 text-slate-750 hover:text-slate-900 shadow-xs'
          }`}
          title="Italic (Ctrl+I)"
        >
          <Italic className="w-3.5 h-3.5" />
        </button>

        {/* 4. Font Color Dropdown */}
        <div className="relative">
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={(e) => toggleDropdown(e, isEdit, 'color')}
            className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg border outline-none cursor-pointer transition-colors ${
              theme === 'dark' 
                ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800' 
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-xs'
            }`}
            title="Text Color"
          >
            <Palette className="w-3.5 h-3.5 text-emerald-500" />
            <span>Text Color</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {colorOpen && (
            <div 
              className={`absolute top-full left-0 z-50 mt-1 p-2 border rounded-lg shadow-xl grid grid-cols-3 gap-1.5 min-w-[130px] ${
                theme === 'dark' ? 'bg-[#0b0f19] border-slate-700' : 'bg-white border-slate-200'
              }`}
              onMouseDown={(e) => e.preventDefault()}
            >
              {AVAILABLE_COLORS.map(c => (
                <button
                  key={c.name}
                  type="button"
                  title={c.name}
                  onClick={() => {
                    executeFormattingCommand(isEdit, 'foreColor', c.value);
                    closeAllDropdowns();
                  }}
                  className="w-7 h-7 rounded-md cursor-pointer border border-slate-300/40 hover:scale-110 active:scale-95 transition-all flex items-center justify-center shrink-0"
                  style={{ backgroundColor: c.value }}
                >
                  <span className="sr-only">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 5. Highlight Background Dropdown */}
        <div className="relative">
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={(e) => toggleDropdown(e, isEdit, 'bg')}
            className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg border outline-none cursor-pointer transition-colors ${
              theme === 'dark' 
                ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800' 
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-xs'
            }`}
            title="Highlight Text Background"
          >
            <Highlighter className="w-3.5 h-3.5 text-amber-500" />
            <span>Highlight</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {bgOpen && (
            <div 
              className={`absolute top-full left-0 z-50 mt-1 p-2 border rounded-lg shadow-xl grid grid-cols-3 gap-1.5 min-w-[145px] ${
                theme === 'dark' ? 'bg-[#0b0f19] border-slate-700' : 'bg-white border-slate-200'
              }`}
              onMouseDown={(e) => e.preventDefault()}
            >
              {AVAILABLE_BGS.map(b => (
                <button
                  key={b.name}
                  type="button"
                  title={b.name}
                  onClick={() => {
                    executeFormattingCommand(isEdit, 'backColor', b.value);
                    closeAllDropdowns();
                  }}
                  className="w-7 h-7 rounded-sm cursor-pointer border border-slate-300/40 hover:scale-110 active:scale-95 transition-all flex items-center justify-center shrink-0"
                  style={{ backgroundColor: b.value }}
                >
                  <span className="sr-only">{b.name}</span>
                </button>
              ))}
              <button
                type="button"
                title="Remove Highlight"
                onClick={() => {
                  executeFormattingCommand(isEdit, 'backColor', 'transparent');
                  closeAllDropdowns();
                }}
                className={`w-7 h-7 rounded-sm border cursor-pointer hover:scale-110 active:scale-95 transition-all flex items-center justify-center text-[10px] font-bold ${
                  theme === 'dark' ? 'border-slate-700 text-slate-400 bg-slate-950' : 'border-slate-300 text-slate-500 bg-white'
                }`}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  useEffect(() => {
    fetchNotices();
  }, []);

  const fetchNotices = async () => {
    setLoading(true);
    try {
      const list = await getAllNotices();
      setNotices(list);
    } catch (err: any) {
      console.error("Failed to query notices: ", err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      alert("Attachment files must be under 8MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (uploadEvent) => {
      const dataUrl = uploadEvent.target?.result as string;
      if (dataUrl) {
        setAttachmentUrl(dataUrl);
        setAttachmentName(file.name);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleEditFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      alert("Attachment files must be under 8MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (uploadEvent) => {
      const dataUrl = uploadEvent.target?.result as string;
      if (dataUrl) {
        setEditAttachmentUrl(dataUrl);
        setEditAttachmentName(file.name);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDirectFileUpload = async (noticeId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      alert("Selected file is too large. Please upload files under 8MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target?.result as string;
      if (!dataUrl) return;
      try {
        await updateNotice(noticeId, {
          attachmentUrl: dataUrl,
          attachmentName: file.name
        });
        alert("Attachment successfully uploaded and saved!");
        fetchNotices();
      } catch (err: any) {
        alert("Failed to upload file attachment: " + err.message);
      }
    };
    reader.readAsDataURL(file);
  };

  const startEditingNotice = (notice: Notice) => {
    setEditingNoticeId(notice.id);
    setEditTitle(notice.title);
    setEditContent(notice.content);
    setEditAttachmentUrl(notice.attachmentUrl || null);
    setEditAttachmentName(notice.attachmentName || null);
    setEditError(null);
  };

  const handleSaveEdit = async (noticeId: string) => {
    if (!editTitle.trim() || !editContent.trim()) {
      setEditError("Title and content are required.");
      return;
    }
    setEditLoading(true);
    setEditError(null);
    try {
      await updateNotice(noticeId, {
        title: editTitle.trim(),
        content: editContent.trim(),
        attachmentUrl: editAttachmentUrl || undefined,
        attachmentName: editAttachmentName || undefined
      });
      setEditingNoticeId(null);
      fetchNotices();
    } catch (err: any) {
      setEditError(err.message || "Failed to update notice.");
    } finally {
      setEditLoading(false);
    }
  };

  const handleCreateNotice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setFormLoading(true);
    setError(null);
    try {
      const email = auth.currentUser?.email || 'admin@plsms.gov.bd';
      const name = currentUserDisplayName || auth.currentUser?.displayName || resolveCreatorName(email);
      const newNotice = {
        title: title.trim(),
        content: content.trim(),
        active: true,
        createdAt: new Date().toISOString(),
        createdBy: email,
        createdByName: name,
        attachmentUrl: attachmentUrl || undefined,
        attachmentName: attachmentName || undefined
      };
      await addNotice(newNotice);
      setTitle('');
      setContent('');
      setAttachmentUrl('');
      setAttachmentName('');
      setShowAddForm(false);
      fetchNotices();
    } catch (err: any) {
      setError(err?.message || "Failed to publish notice document");
    } finally {
      setFormLoading(false);
    }
  };

  const handleToggleActive = async (noticeId: string, currentStatus: boolean) => {
    if (!isSuperuser) {
      alert("Only a Superuser is authorized to activate or disable notices.");
      return;
    }
    try {
      await updateNoticeActiveStatus(noticeId, !currentStatus);
      fetchNotices();
    } catch (err: any) {
      alert("Error toggling active status: " + err.message);
    }
  };

  const executeDelete = async (noticeId: string) => {
    try {
      await deleteNotice(noticeId);
      setDeletingId(null);
      fetchNotices();
    } catch (err: any) {
      alert("Error deleting notice: " + err.message);
    }
  };

  const visibleNotices = notices.filter(n => n.active || isAdmin);

  return (
    <div className="space-y-4 sm:space-y-6 max-w-full mx-auto px-1 sm:px-0 font-sans">
      <div className={`border-b pb-4 ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
        <div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className={`text-base xs:text-lg sm:text-xl font-bold tracking-tight flex items-center gap-2 ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>
              <Volume2 className="w-5 h-5 text-cyan-600 dark:text-cyan-400 animate-pulse shrink-0" />
              Official Notices & Announcements
            </h2>
            {isAdmin && (
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="flex items-center gap-1.5 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-cyan-950/20 shrink-0 active:scale-95 w-fit justify-center"
              >
                <Plus className="w-4 h-4" />
                Create Announcement
              </button>
            )}
          </div>
          <p className={`text-xs sm:text-sm mt-1 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>
            Keep up to date with license delivery schedules, physical document pickup days, and office bulletins.
          </p>
        </div>
      </div>

      {showAddForm && isAdmin && (
        <form onSubmit={handleCreateNotice} className={`p-4 sm:p-5 rounded-2xl border space-y-4 shadow-2xl transition-colors duration-200 ${
          theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className={`flex items-center gap-2 text-xs font-bold uppercase ${
            theme === 'dark' ? 'text-slate-300' : 'text-slate-800'
          }`}>
            <FilePlus className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
            Add New Office Notice
          </div>
          
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 ${
                theme === 'dark' ? 'text-slate-400' : 'text-slate-500'
              }`}>Notice Title</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Itahari TMO: Delayed Handover of Motorcycle Smart Cards"
                className={`w-full px-4 py-2.5 border rounded-xl text-sm transition-colors ${
                  theme === 'dark' ? 'bg-[#0b0f19] border-slate-700/80 text-white placeholder-slate-500 focus:border-cyan-500' : 'bg-white border-slate-250 text-slate-900 placeholder-slate-400 focus:border-cyan-600'
                }`}
              />
            </div>
            <div>
              <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 px-1 ${
                theme === 'dark' ? 'text-slate-400' : 'text-slate-500'
              }`}>Notice Content</label>
              
              {renderRichTextToolbar(false)}

              <NoticeRichEditor
                id="create-editor"
                value={content}
                onChange={setContent}
                theme={theme}
              />
            </div>

            {/* Optional attachment upload button for Create Notice */}
            <div>
              <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1.5 ${
                theme === 'dark' ? 'text-slate-400' : 'text-slate-500'
              }`}>Upload Attachment (JPG, SVG, PDF) - Optional</label>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <input
                  type="file"
                  accept=".jpg,.jpeg,.png,.svg,.pdf"
                  id="notice-attachment-input"
                  className="hidden"
                  onChange={handleCreateFileChange}
                />
                <label
                  htmlFor="notice-attachment-input"
                  className={`flex items-center gap-1.5 px-4 py-2 border rounded-xl text-xs font-bold transition-all cursor-pointer justify-center w-full sm:w-auto ${
                    theme === 'dark'
                      ? 'bg-slate-950 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800'
                      : 'bg-white border-slate-200 text-slate-600 hover:text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  <Upload className="w-4 h-4 text-cyan-500" />
                  Choose Attachment
                </label>
                {attachmentName && (
                  <div className="flex items-center gap-1.5 text-xs text-cyan-400 font-bold truncate w-full sm:w-auto justify-between sm:justify-start">
                    <div className="flex items-center gap-1.5 truncate">
                      <Paperclip className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate max-w-[200px]">{attachmentName}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setAttachmentUrl('');
                        setAttachmentName('');
                      }}
                      className="text-red-400 hover:text-red-350 hover:bg-red-950/20 p-1 rounded transition-all"
                    >
                      <Trash className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-95/20 border border-red-900/35 text-red-400 rounded-xl text-xs font-medium">{error}</div>
          )}

          <div className="flex justify-end gap-2.5">
            <button
              type="button"
              onClick={() => {
                setTitle('');
                setContent('');
                setAttachmentUrl('');
                setAttachmentName('');
                setError(null);
                setShowAddForm(false);
              }}
              className={`px-4 py-2 text-xs font-bold rounded-xl border transition-colors cursor-pointer ${
                theme === 'dark'
                  ? 'text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border-slate-700'
                  : 'text-slate-600 hover:text-slate-800 bg-slate-150 hover:bg-slate-200 border-slate-200'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={formLoading}
              className="px-5 py-2 text-xs font-bold text-white bg-cyan-600 hover:bg-cyan-500 rounded-xl shadow-lg shadow-cyan-950/20 transition-all active:scale-95 disabled:opacity-55 cursor-pointer"
            >
              Publish Notice
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-400 text-xs animate-pulse font-medium">Querying notice board dataset...</div>
      ) : visibleNotices.length === 0 ? (
        <div className={`text-center py-16 rounded-3xl border border-dashed text-sm flex flex-col items-center justify-center gap-2 transition-colors ${
          theme === 'dark' ? 'bg-slate-950/40 border-slate-800 text-slate-400' : 'bg-white border-slate-200 text-slate-500 shadow-xs'
        }`}>
          <ClipboardList className="w-8 h-8 text-slate-400" />
          <span>Notice board is currently clear. Ensure to read this section later for desk alerts.</span>
        </div>
      ) : (
        <div className="space-y-4">
          {visibleNotices.map((n) => (
            <div 
              key={n.id} 
              className={`p-4 sm:p-6 rounded-xl sm:rounded-2xl border transition-all duration-200 ${
                n.active 
                  ? theme === 'dark' 
                    ? 'bg-slate-900 border-slate-800 shadow-lg hover:border-slate-700 text-slate-100' 
                    : 'bg-emerald-50 border-2 border-purple-600 shadow-md hover:border-purple-700 text-slate-900'
                  : theme === 'dark' 
                    ? 'border-slate-85 opacity-55 bg-slate-950/40 text-slate-400' 
                    : 'bg-emerald-50/50 border-2 border-purple-300 opacity-60 text-slate-500'
              }`}
            >
              {editingNoticeId === n.id ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase text-cyan-400">
                    <Pencil className="w-4 h-4 text-cyan-400" />
                    Edit Notice Board Document
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider mb-1 text-slate-400">Notice Title</label>
                    <input
                      type="text"
                      className={`w-full px-4 py-2 border rounded-xl text-sm transition-colors ${
                        theme === 'dark' ? 'bg-[#0b0f19] border-slate-700 text-white focus:border-cyan-500' : 'bg-white border-slate-250 text-slate-900 focus:border-cyan-600'
                      }`}
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider mb-1.5 text-slate-400">Notice Content</label>
                    
                    {renderRichTextToolbar(true)}

                    <NoticeRichEditor
                      id={`edit-editor-${n.id}`}
                      value={editContent}
                      onChange={setEditContent}
                      theme={theme}
                    />
                  </div>

                  {/* Edit Attachment in Edit Mode */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider mb-1 text-slate-400">Attachment File (JPG, SVG, PDF) - Optional</label>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                      <input
                        type="file"
                        accept=".jpg,.jpeg,.png,.svg,.pdf"
                        id={`edit-attachment-file-${n.id}`}
                        className="hidden"
                        onChange={handleEditFileChange}
                      />
                      <label
                        htmlFor={`edit-attachment-file-${n.id}`}
                        className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-xl text-xs font-bold transition-all cursor-pointer justify-center w-full sm:w-auto ${
                          theme === 'dark'
                            ? 'bg-slate-950 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800'
                            : 'bg-white border-slate-200 text-slate-600 hover:text-slate-800 hover:bg-slate-50'
                        }`}
                      >
                        <Upload className="w-3.5 h-3.5 text-cyan-500" />
                        Choose File
                      </label>
                      {editAttachmentName && (
                        <div className="flex items-center gap-1.5 text-xs text-cyan-400 font-bold truncate w-full sm:w-auto justify-between sm:justify-start">
                          <div className="flex items-center gap-1.5 truncate">
                            <Paperclip className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate max-w-[200px]">{editAttachmentName}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEditAttachmentUrl(null);
                              setEditAttachmentName(null);
                            }}
                            className="text-red-400 hover:text-red-350 ml-1 hover:bg-red-955/20 p-1 rounded transition-all"
                          >
                            <Trash className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {editError && (
                    <div className="p-3 bg-red-95/20 border border-red-900/35 text-red-400 rounded-xl text-xs font-medium">{editError}</div>
                  )}

                  <div className="flex justify-end gap-2.5 mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingNoticeId(null);
                        setEditContent('');
                        setEditAttachmentUrl(null);
                        setEditAttachmentName(null);
                        setEditError(null);
                      }}
                      className={`px-4 py-2 text-xs font-bold rounded-xl border transition-colors cursor-pointer ${
                        theme === 'dark'
                          ? 'text-slate-400 hover:text-white bg-slate-850 hover:bg-slate-800 border-slate-700'
                          : 'text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-150 border-slate-200'
                      }`}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={editLoading}
                      onClick={() => handleSaveEdit(n.id)}
                      className="px-5 py-2 text-xs font-bold text-white bg-cyan-600 hover:bg-cyan-500 rounded-xl shadow-lg shadow-cyan-950/20 transition-all active:scale-95 disabled:opacity-55 cursor-pointer"
                    >
                      {editLoading ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={`font-extrabold text-sm xs:text-base transition-colors ${theme === 'dark' ? 'text-white' : 'text-blue-600 font-extrabold'}`}>{n.title}</h3>
                      {!n.active && (
                        <span className="bg-slate-800 border border-slate-750 text-slate-400 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider shrink-0">
                          Disabled Notice
                        </span>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-1.5 text-[11px] sm:text-xs text-slate-500 font-medium shrink-0">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>{convertADToBS(n.createdAt)}</span>
                    </div>
                  </div>

                  <div 
                    className={`text-xs sm:text-sm leading-relaxed transition-colors break-words ${theme === 'dark' ? 'text-slate-300' : 'text-slate-750'}`}
                    dangerouslySetInnerHTML={renderNoticeHTML(n.content, theme)}
                  />

                  {/* Render attachment if exists */}
                  {n.attachmentUrl && (
                    <div className={`mt-4 p-3 rounded-xl border flex flex-col xs:flex-row xs:items-center justify-between gap-3 text-xs ${
                      theme === 'dark' ? 'bg-slate-950/60 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-150 text-slate-700'
                    }`}>
                      <div className="flex items-center gap-2 truncate min-w-0">
                        <File className="w-4 h-4 text-cyan-500 shrink-0" />
                        <span className="font-semibold truncate text-[11px]">{n.attachmentName || 'Attached Document'}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 w-full xs:w-auto justify-end">
                        <a
                          href={n.attachmentUrl}
                          download={n.attachmentName || 'document'}
                          className="px-2.5 py-1 bg-cyan-600/15 hover:bg-cyan-600/25 text-cyan-400 font-bold rounded-lg transition-all flex items-center gap-1 cursor-pointer text-[10px] uppercase tracking-wider flex-1 xs:flex-none text-center justify-center"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </a>
                        <a
                          href={n.attachmentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 hover:text-white text-slate-300 font-bold rounded-lg transition-all flex items-center gap-1 cursor-pointer text-[10px] uppercase tracking-wider flex-1 xs:flex-none text-center justify-center"
                        >
                          Open File
                        </a>
                      </div>
                    </div>
                  )}

                  {isAdmin && (
                    <div className={`border-t mt-4 pt-3 flex items-center justify-between ${theme === 'dark' ? 'border-slate-800' : 'border-slate-100'}`}>
                      <span className="text-[10px] text-slate-500">Published by: <span className="font-bold text-slate-300">{resolveCreatorName(n.createdBy, n.createdByName)}</span></span>
                      <div className="flex items-center gap-2">
                        {deletingId === n.id ? (
                          <div className="flex items-center gap-2 bg-red-955/20 border border-red-900/40 px-2.5 py-1 rounded-lg">
                            <span className="text-[10px] text-red-400 font-bold uppercase tracking-wider animate-pulse">Are you sure?</span>
                            <button
                              onClick={() => executeDelete(n.id)}
                              className="px-2 py-0.5 bg-red-600 hover:bg-red-500 text-white rounded text-[9px] font-bold uppercase tracking-wider cursor-pointer transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setDeletingId(null)}
                              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[9px] font-bold uppercase tracking-wider cursor-pointer transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            {/* Superuser Edit Button */}
                            {isSuperuser && (
                              <button
                                onClick={() => startEditingNotice(n)}
                                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer border ${
                                  theme === 'dark'
                                    ? 'border-indigo-900/40 text-indigo-400 bg-indigo-950/25 hover:bg-indigo-950/45'
                                    : 'border-indigo-300 text-indigo-800 bg-indigo-50 hover:bg-indigo-100 hover:scale-102 active:scale-98'
                                }`}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                                Edit
                              </button>
                            )}

                            {/* Superuser direct upload button placed very near to the left of Disable Notice */}
                            {isSuperuser && (
                              <div className="relative inline-block">
                                <input
                                  type="file"
                                  accept=".jpg,.jpeg,.png,.svg,.pdf"
                                  id={`direct-upload-${n.id}`}
                                  className="hidden"
                                  onChange={(e) => handleDirectFileUpload(n.id, e)}
                                />
                                <label
                                  htmlFor={`direct-upload-${n.id}`}
                                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer border ${
                                    theme === 'dark'
                                      ? 'border-cyan-900/40 text-cyan-400 bg-cyan-950/25 hover:bg-cyan-950/45'
                                      : 'border-cyan-300 text-cyan-800 bg-cyan-50 hover:bg-cyan-100 hover:scale-102 active:scale-98'
                                  }`}
                                >
                                  <Upload className="w-3.5 h-3.5" />
                                  {n.attachmentUrl ? 'Change File' : 'Upload File'}
                                </label>
                              </div>
                            )}

                            {isSuperuser && (
                              <button
                                onClick={() => handleToggleActive(n.id, n.active)}
                                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-all cursor-pointer ${
                                  theme === 'dark'
                                    ? (n.active 
                                        ? 'border-amber-900/60 text-amber-500 bg-amber-955/25 hover:bg-amber-950/45' 
                                        : 'border-emerald-900/60 text-emerald-600 bg-emerald-95/25 hover:bg-emerald-100/40')
                                    : (n.active
                                        ? 'border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100'
                                        : 'border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100')
                                }`}
                              >
                                {n.active ? (
                                  <>
                                    <XCircle className="w-3.5 h-3.5" />
                                    Disable Notice
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    Activate Notice
                                  </>
                                )}
                              </button>
                            )}
                            
                            {isSuperuser && (
                              <button
                                onClick={() => setDeletingId(n.id)}
                                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer border ${
                                  theme === 'dark'
                                    ? 'border-red-900/40 text-red-400 bg-red-95/30 hover:bg-red-100/50'
                                    : 'border-red-300 text-red-800 bg-red-50 hover:bg-red-100 hover:scale-102 active:scale-98'
                                }`}
                              >
                                <Trash className="w-3.5 h-3.5" />
                                Delete
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
