// Firebase configuration.
const firebaseConfig = {
  apiKey: "AIzaSyB0a0ypQx03ZtyYlJ9EvBD0cJqryRqDINA",
  authDomain: "multiverse-star-battle.firebaseapp.com",
  projectId: "multiverse-star-battle",
  storageBucket: "multiverse-star-battle.firebasestorage.app",
  messagingSenderId: "125582722457",
  appId: "1:125582722457:web:76e185dca1bbec297d7f08"
};

// Initialize Firebase.
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

class StorageManager {
  constructor() {
    this.user = null;
    this.onAuthChangeCallback = null;
    this.onCloudDataLoadedCallback = null;
    this._solvedCache = JSON.parse(localStorage.getItem('sb_solved') || '[]');
    // Solve times and in-progress elapsed times are local-only: unlike
    // _solvedCache, they are never pushed to or pulled from Firestore.
    this._solveTimesCache = JSON.parse(localStorage.getItem('sb_solve_times') || '{}');
    this._elapsedTimesCache = JSON.parse(localStorage.getItem('sb_elapsed_times') || '{}');

    // Clean up obsolete uncompressed save data.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb_state_') && !key.startsWith('sb_v2_state_')) {
        localStorage.removeItem(key);
      }
    }

    auth.onAuthStateChanged(user => {
      this.user = user;
      if (this.onAuthChangeCallback) this.onAuthChangeCallback(user);
      if (user) {
        this._syncFromCloud();
      }
    });

    // Handle redirect sign-in callback.
    auth.getRedirectResult().catch(error => {
      console.error("Redirect sign-in error", error);
    });
  }

  setCallbacks({ onAuthChange, onCloudDataLoaded }) {
    this.onAuthChangeCallback = onAuthChange;
    this.onCloudDataLoadedCallback = onCloudDataLoaded;
    if (this.user && onAuthChange) onAuthChange(this.user);
  }

  async signIn() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
    } catch (error) {
      console.error("Sign-in error", error);
    }
  }

  async signOut() {
    try {
      await auth.signOut();
    } catch (error) {
      console.error("Sign-out error", error);
    }
  }

  // --- Serialization ---
  _serializeState(stateArray) {
    if (!stateArray) return null;
    return stateArray.map(cell => {
      if (cell === 'star') return 'S';
      if (cell === 'dot') return '.';
      return '-';
    }).join('');
  }

  _deserializeState(stateString) {
    if (!stateString) return null;
    return stateString.split('').map(char => {
      if (char === 'S') return 'star';
      if (char === '.') return 'dot';
      return 'none';
    });
  }

  // --- Local Storage ---
  getSolvedList() {
    return [...this._solvedCache];
  }

  getPuzzleState(puzzleId) {
    const state = localStorage.getItem(`sb_v2_state_${puzzleId}`);
    return state ? this._deserializeState(state) : null;
  }

  savePuzzleState(puzzleId, stateArray) {
    localStorage.setItem(`sb_v2_state_${puzzleId}`, this._serializeState(stateArray));
  }

  markPuzzleSolved(puzzleId) {
    if (!this._solvedCache.includes(puzzleId)) {
      this._solvedCache.push(puzzleId);
      localStorage.setItem('sb_solved', JSON.stringify(this._solvedCache));
      
      // Push the solved delta to Firestore.
      if (this.user) {
        db.collection('users').doc(this.user.uid).set({
          solved: firebase.firestore.FieldValue.arrayUnion(puzzleId)
        }, { merge: true }).catch(err => console.error("Error pushing solve to cloud", err));
      }
    }
  }

  // --- Solve Times (local-only; never synced to the cloud) ---

  // Get the best recorded solve time (in seconds) for a puzzle, or null if none.
  getSolveTime(puzzleId) {
    const val = this._solveTimesCache[puzzleId];
    return typeof val === 'number' ? val : null;
  }

  // Persist a solve time only if it beats (is lower than) any previously
  // recorded time for this puzzle.
  saveSolveTime(puzzleId, seconds) {
    const existing = this._solveTimesCache[puzzleId];
    if (typeof existing === 'number' && existing <= seconds) return;
    this._solveTimesCache[puzzleId] = seconds;
    localStorage.setItem('sb_solve_times', JSON.stringify(this._solveTimesCache));
  }

  // --- In-progress Timer (local-only; never synced to the cloud) ---

  // Get the saved in-progress elapsed time (in seconds) for an unsolved puzzle.
  getElapsedTime(puzzleId) {
    const val = this._elapsedTimesCache[puzzleId];
    return typeof val === 'number' ? val : null;
  }

  // Persist the current in-progress elapsed time for an unsolved puzzle.
  saveElapsedTime(puzzleId, seconds) {
    this._elapsedTimesCache[puzzleId] = seconds;
    localStorage.setItem('sb_elapsed_times', JSON.stringify(this._elapsedTimesCache));
  }

  // Clear a puzzle's in-progress elapsed time (e.g. once it's been solved).
  clearElapsedTime(puzzleId) {
    if (puzzleId in this._elapsedTimesCache) {
      delete this._elapsedTimesCache[puzzleId];
      localStorage.setItem('sb_elapsed_times', JSON.stringify(this._elapsedTimesCache));
    }
  }

  clearAllPuzzleData() {
    this._solvedCache = [];
    this._solveTimesCache = {};
    this._elapsedTimesCache = {};
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === 'sb_solved' || key === 'sb_solve_times' || key === 'sb_elapsed_times' ||
        key.startsWith('sb_v2_state_')) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(k => localStorage.removeItem(k));
    this._syncToCloud(true);
  }

  // --- Cloud Sync ---
  async _syncFromCloud() {
    if (!this.user) return;
    try {
      const docRef = db.collection('users').doc(this.user.uid);
      const docSnap = await docRef.get();
      let needsSync = false;

      if (docSnap.exists) {
        const data = docSnap.data();

        // Merge solved puzzle history.
        const cloudSolved = data.solved || [];
        const mergedSolved = [...new Set([...this._solvedCache, ...cloudSolved])];
        
        if (this._solvedCache.length !== mergedSolved.length) {
          this._solvedCache = mergedSolved;
          localStorage.setItem('sb_solved', JSON.stringify(this._solvedCache));
          needsSync = true;
        }
      } else if (this._solvedCache.length > 0) {
        // Initialize cloud document with local cache if missing.
        needsSync = true;
      }

      if (this.onCloudDataLoadedCallback) {
        this.onCloudDataLoadedCallback();
      }

      if (needsSync) {
        this._syncToCloud();
      }
    } catch (error) {
      // Firebase is unavailable. Log the error but do NOT call onCloudDataLoadedCallback —
      // the game should already be running on local data, so retriggering loadProgress
      // on a potentially uninitialized puzzle would cause crashes.
      console.warn("Cloud sync unavailable; continuing with local data only.", error);
    }
  }

  async _syncToCloud(isClearAll = false) {
    if (!this.user) return;

    if (isClearAll) {
      try {
        await db.collection('users').doc(this.user.uid).set({ solved: [] }, { merge: true });
      } catch (error) {
        console.error("Error clearing cloud data", error);
      }
      return;
    }

    try {
      const docRef = db.collection('users').doc(this.user.uid);
      if (this._solvedCache.length > 0) {
        await docRef.set({
          solved: firebase.firestore.FieldValue.arrayUnion(...this._solvedCache)
        }, { merge: true });
      }
    } catch (error) {
      console.error("Error syncing to cloud", error);
    }
  }
}

// Expose as an ES module export
export const storageManager = new StorageManager();
