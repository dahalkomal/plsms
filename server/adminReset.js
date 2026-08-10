import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';
import path from 'path';

// Load Firebase configuration
let firebaseConfig = {
  projectId: "calcium-buffer-3cf5x",
  firestoreDatabaseId: "ai-studio-83193a88-b525-4a3a-b61d-37c4529e8a91"
};

try {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.projectId) firebaseConfig.projectId = parsed.projectId;
    if (parsed.firestoreDatabaseId) firebaseConfig.firestoreDatabaseId = parsed.firestoreDatabaseId;
  }
} catch (e) {
  console.warn("[ADMIN RESET SERVER] Notice: Using default Firebase config parameters:", e.message);
}

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId;

// Initialize Firebase Admin SDK
let adminApp;
if (getApps().length === 0) {
  adminApp = initializeApp({ projectId });
} else {
  adminApp = getApps()[0];
}

let adminDb;
try {
  adminDb = getFirestore(adminApp, databaseId);
} catch (e) {
  adminDb = getFirestore(adminApp);
}

// Global server reset task state for progress polling
let resetTaskState = {
  isRunning: false,
  stage: 'Idle',
  licensesDeleted: 0,
  ledgersDeleted: 0,
  subcollectionsDeleted: 0,
  requestsDeleted: 0,
  totalDeleted: 0,
  completed: false,
  verified: false,
  error: null,
  startTime: null,
  endTime: null,
};

/**
 * Verifies that the incoming request is sent by an authenticated Super Administrator.
 * Uses Firebase Admin verifyIdToken and checks Firestore /users_roles collection.
 */
async function verifySuperAdminToken(req) {
  let token = null;
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    token = authHeader.split('Bearer ')[1].trim();
  } else if (req.body && req.body.idToken) {
    token = req.body.idToken;
  }

  if (!token) {
    throw new Error("Missing authentication token. Bearer Authorization header or idToken required.");
  }

  let decodedToken = null;
  try {
    decodedToken = await getAuth(adminApp).verifyIdToken(token);
  } catch (err) {
    console.error("[SERVER RESET AUTH] Token verification failed:", err.message);
    throw new Error("Invalid or expired authentication session. Please sign in again.");
  }

  const uid = decodedToken.uid;
  const email = (decodedToken.email || req.body.userEmail || '').toLowerCase().trim();

  if (!email) {
    throw new Error("No verified email address associated with authentication session.");
  }

  // 1. Super Admin email pattern check
  const isSuperAdminEmail = email === 'dahalkomal@gmail.com' || email.startsWith('superuser') || email.startsWith('superadmin');

  // 2. Query Firestore /users_roles collection
  let isSuperAdminRole = false;
  try {
    const rolesCol = adminDb.collection('users_roles');
    
    // Check by UID
    const roleDocUid = await rolesCol.doc(uid).get();
    if (roleDocUid.exists) {
      const data = roleDocUid.data();
      if (data?.role === 'superuser' || data?.role === 'SUPER_ADMIN' || data?.id === 'Super_Admin') {
        isSuperAdminRole = true;
      }
    }
    
    // Check by email
    if (!isSuperAdminRole) {
      const roleDocEmail = await rolesCol.doc(email).get();
      if (roleDocEmail.exists) {
        const data = roleDocEmail.data();
        if (data?.role === 'superuser' || data?.role === 'SUPER_ADMIN') {
          isSuperAdminRole = true;
        }
      }
    }

    // Check Super_Admin document members list
    if (!isSuperAdminRole) {
      const superAdminDoc = await rolesCol.doc('Super_Admin').get();
      if (superAdminDoc.exists) {
        const data = superAdminDoc.data();
        if (Array.isArray(data?.members) && (data.members.includes(email) || data.members.includes(uid))) {
          isSuperAdminRole = true;
        }
      }
    }
  } catch (dbErr) {
    console.warn("[SERVER RESET AUTH] Role doc lookup notice:", dbErr.message);
  }

  if (!isSuperAdminEmail && !isSuperAdminRole) {
    throw new Error(`Permission Denied: User '${email}' is not authorized as Super Administrator.`);
  }

  return { uid, email };
}

/**
 * Server-side high-speed bulk deletion engine.
 * Uses Firestore BulkWriter with .select() field-masking for extreme speed and low RAM footprint.
 */
async function executeProductionDataReset(userEmail, userUid, reqIp) {
  resetTaskState = {
    isRunning: true,
    stage: 'Initiating server-side production data reset...',
    licensesDeleted: 0,
    ledgersDeleted: 0,
    subcollectionsDeleted: 0,
    requestsDeleted: 0,
    totalDeleted: 0,
    completed: false,
    verified: false,
    error: null,
    startTime: new Date().toISOString(),
    endTime: null,
  };

  try {
    console.log("[SERVER RESET ENGINE] Starting server-side production reset for:", userEmail);

    // 1. DELETE /licenses in large batches using .select() metadata query
    resetTaskState.stage = 'Deleting license records from Firestore...';
    const licensesCol = adminDb.collection('licenses');
    
    while (true) {
      const snapshot = await licensesCol.select().limit(3000).get();
      if (snapshot.empty) break;

      const docs = snapshot.docs;
      const bulkWriter = adminDb.bulkWriter();
      bulkWriter.onWriteError((error) => {
        return error.failedAttempts < 5;
      });

      for (const docSnap of docs) {
        bulkWriter.delete(docSnap.ref);
      }
      await bulkWriter.close();

      resetTaskState.licensesDeleted += docs.length;
      resetTaskState.totalDeleted = resetTaskState.licensesDeleted + resetTaskState.ledgersDeleted + resetTaskState.subcollectionsDeleted + resetTaskState.requestsDeleted;
      resetTaskState.stage = `Deleting license records (${resetTaskState.licensesDeleted.toLocaleString()} deleted)...`;

      if (docs.length < 3000) break;
    }

    // 2. DELETE /upload_ledgers and subcollections (/records and /checkpoints)
    resetTaskState.stage = 'Deleting upload ledgers and subcollection metadata...';
    const ledgersCol = adminDb.collection('upload_ledgers');
    while (true) {
      const ledgersSnap = await ledgersCol.select().limit(200).get();
      if (ledgersSnap.empty) break;

      for (const ledgerDoc of ledgersSnap.docs) {
        // Delete subcollection 'records'
        const recordsCol = ledgerDoc.ref.collection('records');
        while (true) {
          const recSnap = await recordsCol.select().limit(3000).get();
          if (recSnap.empty) break;

          const bw = adminDb.bulkWriter();
          recSnap.docs.forEach(d => bw.delete(d.ref));
          await bw.close();

          resetTaskState.subcollectionsDeleted += recSnap.docs.length;
          resetTaskState.totalDeleted = resetTaskState.licensesDeleted + resetTaskState.ledgersDeleted + resetTaskState.subcollectionsDeleted + resetTaskState.requestsDeleted;
          if (recSnap.docs.length < 3000) break;
        }

        // Delete subcollection 'checkpoints'
        const checkCol = ledgerDoc.ref.collection('checkpoints');
        while (true) {
          const chkSnap = await checkCol.select().limit(3000).get();
          if (chkSnap.empty) break;

          const bw = adminDb.bulkWriter();
          chkSnap.docs.forEach(d => bw.delete(d.ref));
          await bw.close();

          resetTaskState.subcollectionsDeleted += chkSnap.docs.length;
          resetTaskState.totalDeleted = resetTaskState.licensesDeleted + resetTaskState.ledgersDeleted + resetTaskState.subcollectionsDeleted + resetTaskState.requestsDeleted;
          if (chkSnap.docs.length < 3000) break;
        }

        // Delete parent ledger document
        await ledgerDoc.ref.delete();
        resetTaskState.ledgersDeleted++;
        resetTaskState.totalDeleted = resetTaskState.licensesDeleted + resetTaskState.ledgersDeleted + resetTaskState.subcollectionsDeleted + resetTaskState.requestsDeleted;
        resetTaskState.stage = `Deleting upload ledgers (${resetTaskState.ledgersDeleted} ledgers, ${resetTaskState.subcollectionsDeleted.toLocaleString()} sub-records deleted)...`;
      }

      if (ledgersSnap.docs.length < 200) break;
    }

    // 3. DELETE /collection_requests
    resetTaskState.stage = 'Deleting card collection requests...';
    const requestsCol = adminDb.collection('collection_requests');
    while (true) {
      const reqSnap = await requestsCol.select().limit(3000).get();
      if (reqSnap.empty) break;

      const bw = adminDb.bulkWriter();
      reqSnap.docs.forEach(d => bw.delete(d.ref));
      await bw.close();

      resetTaskState.requestsDeleted += reqSnap.docs.length;
      resetTaskState.totalDeleted = resetTaskState.licensesDeleted + resetTaskState.ledgersDeleted + resetTaskState.subcollectionsDeleted + resetTaskState.requestsDeleted;
      resetTaskState.stage = `Deleting collection requests (${resetTaskState.requestsDeleted.toLocaleString()} deleted)...`;

      if (reqSnap.docs.length < 3000) break;
    }

    // 4. RESET STATISTICS /statistics/search_served
    try {
      await adminDb.collection('statistics').doc('search_served').set({ totalSearchesServed: 0 });
    } catch (statErr) {
      console.warn("[SERVER RESET ENGINE] Statistics reset notice:", statErr.message);
    }

    // 5. FINAL SERVER-SIDE COUNT VERIFICATION
    resetTaskState.stage = 'Performing server-side count verification...';
    const licensesCountSnap = await licensesCol.count().get();
    const ledgersCountSnap = await ledgersCol.count().get();
    const requestsCountSnap = await requestsCol.count().get();

    const remainingLicenses = licensesCountSnap.data().count;
    const remainingLedgers = ledgersCountSnap.data().count;
    const remainingRequests = requestsCountSnap.data().count;

    const isVerified = remainingLicenses === 0 && remainingLedgers === 0 && remainingRequests === 0;

    resetTaskState.verified = isVerified;
    resetTaskState.completed = true;
    resetTaskState.endTime = new Date().toISOString();

    if (!isVerified) {
      resetTaskState.error = `Verification incomplete: ${remainingLicenses} licenses, ${remainingLedgers} ledgers, ${remainingRequests} requests remain in Firestore.`;
      resetTaskState.stage = 'Reset incomplete - records remain in target collections.';
      console.error("[SERVER RESET ENGINE] " + resetTaskState.error);
    } else {
      resetTaskState.stage = `Production data reset completed & verified! ${resetTaskState.totalDeleted.toLocaleString()} total records purged.`;
      console.log("[SERVER RESET ENGINE] RESET SUCCESSFUL AND VERIFIED.");

      // Save Security Audit Log
      try {
        const now = new Date();
        await adminDb.collection('security_audit_logs').add({
          timestamp: now.toISOString(),
          username: userEmail,
          ipAddress: reqIp || '127.0.0.1',
          status: 'DATABASE_RESET_SUCCESS',
          reason: `Authorized Server-Side Production Data Reset: Purged ${resetTaskState.totalDeleted.toLocaleString()} records. Zero documents remain in /licenses, /upload_ledgers, and /collection_requests.`,
          superAdminEmail: userEmail,
          deletedBy: 'Super Admin',
          date: now.toISOString().split('T')[0],
          time: now.toTimeString().split(' ')[0],
          totalRecordsDeleted: resetTaskState.totalDeleted,
          deviceSession: 'Server-Side BulkWriter Engine'
        });
      } catch (auditErr) {
        console.warn("[SERVER RESET ENGINE] Security audit log write notice:", auditErr.message);
      }
    }

  } catch (err) {
    console.error("[SERVER RESET ENGINE ERROR]:", err);
    resetTaskState.isRunning = false;
    resetTaskState.completed = false;
    resetTaskState.verified = false;
    resetTaskState.error = err.message || String(err);
    resetTaskState.stage = `Reset failed: ${resetTaskState.error}`;
  } finally {
    resetTaskState.isRunning = false;
  }
}

/**
 * Express Route Handler: POST /api/admin/reset-production-data
 */
export async function handleResetProductionData(req, res) {
  try {
    const { confirmationText, confirmChecked, userEmail } = req.body || {};

    if (confirmationText !== 'RESET PLSMS PRODUCTION DATA') {
      return res.status(400).json({
        success: false,
        error: "Invalid confirmation string. Please type 'RESET PLSMS PRODUCTION DATA' exactly as required."
      });
    }

    if (!confirmChecked) {
      return res.status(400).json({
        success: false,
        error: "Explicit confirmation checkbox must be checked before proceeding."
      });
    }

    if (resetTaskState.isRunning) {
      return res.status(409).json({
        success: false,
        error: "A production data reset operation is already in progress on the server.",
        status: resetTaskState
      });
    }

    // Verify Super Administrator authorization
    const { email: verifiedEmail, uid: verifiedUid } = await verifySuperAdminToken(req);

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

    // Launch background reset worker
    executeProductionDataReset(verifiedEmail, verifiedUid, clientIp);

    return res.json({
      success: true,
      message: "Server-side production data reset task initiated successfully.",
      status: resetTaskState
    });

  } catch (err) {
    console.error("[API RESET HANDLER ERROR]:", err.message);
    const statusCode = err.message.includes('Permission Denied') ? 403 : 400;
    return res.status(statusCode).json({
      success: false,
      error: err.message || "Failed to authorize or execute production data reset."
    });
  }
}

/**
 * Express Route Handler: GET /api/admin/reset-status
 */
export function handleResetStatus(req, res) {
  return res.json({
    success: true,
    status: resetTaskState
  });
}
