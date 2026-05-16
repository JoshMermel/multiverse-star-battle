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
    this._syncTimeout = null;

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
    return JSON.parse(localStorage.getItem('sb_solved') || '[]');
  }

  getPuzzleState(puzzleId) {
    const state = localStorage.getItem(`sb_v2_state_${puzzleId}`);
    return state ? this._deserializeState(state) : null;
  }

  savePuzzleState(puzzleId, stateArray) {
    localStorage.setItem(`sb_v2_state_${puzzleId}`, this._serializeState(stateArray));
  }

  markPuzzleSolved(puzzleId) {
    const solved = this.getSolvedList();
    if (!solved.includes(puzzleId)) {
      solved.push(puzzleId);
      localStorage.setItem('sb_solved', JSON.stringify(solved));
      this._syncToCloud();
    }
  }

  clearAllPuzzleData() {
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
    console.log("Syncing from cloud");
    if (!this.user) return;
    console.log("Syncing from cloud 2");
    try {
      const docRef = db.collection('users').doc(this.user.uid);
      const docSnap = await docRef.get();
      if (docSnap.exists) {
        const data = docSnap.data();

        // Merge solved list
        const localSolved = this.getSolvedList();
        const cloudSolved = data.solved || [];
        const mergedSolved = [...new Set([...localSolved, ...cloudSolved])];
        localStorage.setItem('sb_solved', JSON.stringify(mergedSolved));
      }

      if (this.onCloudDataLoadedCallback) {
        this.onCloudDataLoadedCallback();
      }

      // Push the newly merged local state back up to the cloud so that
      // this device's pre-existing local data is shared across devices.
      this._syncToCloud();
    } catch (error) {
      console.error("Error syncing from cloud", error);
    }
  }

  async _syncToCloud(isClearAll = false) {
    console.log("Syncing to cloud");
    if (!this.user) return;
    console.log("Syncing to cloud 2");

    // To avoid spamming Firestore on every cell click, we debounce this.
    clearTimeout(this._syncTimeout);
    this._syncTimeout = setTimeout(async () => {
      try {
        const docRef = db.collection('users').doc(this.user.uid);

        if (isClearAll) {
          await docRef.set({ solved: [] });
          return;
        }

        // Gather local solved data
        const solved = this.getSolvedList();

        await docRef.set({
          solved: solved
        }); // Overwrite cloud document with local solved list (states are kept local)
      } catch (error) {
        console.error("Error syncing to cloud", error);
      }
    }, 2000); // 2 second debounce
  }
}

// Expose as an ES module export
export const storageManager = new StorageManager();
