import React, { useState, useEffect } from 'react';
import { auth, db, startEmailSignIn } from '../firebase';
import { doc, setDoc } from 'firebase/firestore';
import { isDemoModeActive, setDemoModeActive } from '../dbService';
import { AppRole } from '../types';
import { Shield, Sparkles, User, RefreshCw, AlertCircle } from 'lucide-react';

interface DevSwitcherProps {
  currentRole: AppRole;
  userEmail: string | null;
  onRoleChanged: () => void;
}

export default function DevSwitcher({ currentRole, userEmail, onRoleChanged }: DevSwitcherProps) {
  return null;
}
