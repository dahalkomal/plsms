import React, { createContext, useContext, useState, useEffect } from 'react';

interface PageTitleContextType {
  title: string;
  setTitle: (title: string) => void;
  nestedTitle: string | null;
  setNestedTitle: (title: string | null) => void;
}

const PageTitleContext = createContext<PageTitleContextType>({
  title: '',
  setTitle: () => {},
  nestedTitle: null,
  setNestedTitle: () => {},
});

export const PageTitleProvider: React.FC<{ children: React.ReactNode; defaultTitle?: string }> = ({ children, defaultTitle = '' }) => {
  const [title, setTitle] = useState(defaultTitle);
  const [nestedTitle, setNestedTitle] = useState<string | null>(null);

  useEffect(() => {
    if (defaultTitle) {
      setTitle(prev => prev === defaultTitle ? prev : defaultTitle);
      setNestedTitle(prev => prev === null ? prev : null);
    }
  }, [defaultTitle]);

  return (
    <PageTitleContext.Provider value={{ title, setTitle, nestedTitle, setNestedTitle }}>
      {children}
    </PageTitleContext.Provider>
  );
};

export const usePageTitle = (customTitle?: string | null) => {
  const { nestedTitle, setTitle, setNestedTitle } = useContext(PageTitleContext);

  useEffect(() => {
    if (customTitle !== undefined) {
      const target = customTitle || null;
      if (nestedTitle !== target) {
        setNestedTitle(target);
      }
    }
  }, [customTitle, nestedTitle, setNestedTitle]);

  return { setTitle, setNestedTitle };
};

interface PageHeaderProps {
  title?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title: propTitle }) => {
  const { title: contextTitle, nestedTitle } = useContext(PageTitleContext);

  const displayTitle = nestedTitle || propTitle || contextTitle;

  if (!displayTitle) return null;

  return (
    <div className="w-full pt-3 pb-2 px-4 flex flex-col items-center justify-center transition-all duration-300">
      <h1 className="page-header-title text-[18px] sm:text-[22px] font-black tracking-[0.16em] uppercase text-center text-[#1e3a8a] dark:text-cyan-400 leading-none font-sans invisible sm:visible">
        {displayTitle}
      </h1>
    </div>
  );
};

export default PageHeader;
