// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyB0a0ypQx03ZtyYlJ9EvBD0cJqryRqDINA",
  authDomain: "multiverse-star-battle.firebaseapp.com",
  projectId: "multiverse-star-battle",
  storageBucket: "multiverse-star-battle.firebasestorage.app",
  messagingSenderId: "125582722457",
  appId: "1:125582722457:web:76e185dca1bbec297d7f08"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

class StorageManager {
  constructor() {
    this.user = null;
    this.onAuthChangeCallback = null;
    this.onCloudDataLoadedCallback = null;
    this._solvedCache = JSON.parse(localStorage.getItem('sb_solved') || '[]');

    // Cleanup legacy uncompressed save files to free up localStorage space
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

    // Required to complete the sign-in flow after the page reloads from a redirect
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

  // --- Local Storage Accessors ---
  getSolvedList() {
    return [...this._solvedCache]; // return a copy to prevent accidental mutations
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
      
      // Push just the delta to the cloud
      if (this.user) {
        db.collection('users').doc(this.user.uid).set({
          solved: firebase.firestore.FieldValue.arrayUnion(puzzleId)
        }, { merge: true }).catch(err => console.error("Error pushing solve to cloud", err));
      }
    }
  }

  clearAllPuzzleData() {
    this._solvedCache = [];
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === 'sb_solved' || key.startsWith('sb_v2_state_')) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(k => localStorage.removeItem(k));
    this._syncToCloud(true); // pass true to indicate a full clear on cloud too
  }

  // --- Cloud Syncing ---
  async _syncFromCloud() {
    if (!this.user) return;
    try {
      const docRef = db.collection('users').doc(this.user.uid);
      const docSnap = await docRef.get();
      let needsSync = false;

      if (docSnap.exists) {
        const data = docSnap.data();

        // Merge solved list
        const cloudSolved = data.solved || [];
        const mergedSolved = [...new Set([...this._solvedCache, ...cloudSolved])];
        
        if (this._solvedCache.length !== mergedSolved.length) {
          this._solvedCache = mergedSolved;
          localStorage.setItem('sb_solved', JSON.stringify(this._solvedCache));
          needsSync = true;
        }
      } else if (this._solvedCache.length > 0) {
        // Doc doesn't exist, we must create it with our local cache
        needsSync = true;
      }

      if (this.onCloudDataLoadedCallback) {
        this.onCloudDataLoadedCallback();
      }

      if (needsSync) {
        this._syncToCloud();
      }
    } catch (error) {
      console.error("Error syncing from cloud", error);
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
        }, { merge: true }); // Push any local-only solves using arrayUnion
      }
    } catch (error) {
      console.error("Error syncing to cloud", error);
    }
  }
}

// Expose as an ES module export
export const storageManager = new StorageManager();
