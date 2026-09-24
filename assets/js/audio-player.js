/**
 * AudioPlayer - Maneja toda la lógica del reproductor de audio
 * Centralizado para todos los templates
 */
class AudioPlayer {
  constructor(options = {}) {
    this.audioElement = null;
    this.isPlaying = false;
    this.currentVolume = options.defaultVolume || 50;
    this.streamUrl = null;
    this.onPlayCallback = options.onPlay || (() => {});
    this.onPauseCallback = options.onPause || (() => {});
    this.onErrorCallback = options.onError || (() => {});
    this.onVolumeChangeCallback = options.onVolumeChange || (() => {});
    
    this.audioElementId = options.audioElementId || 'radio-audio';
    this.playButtonId = options.playButtonId || 'play-btn';
    this.volumeSliderId = options.volumeSliderId || 'volume-slider';

    // Estado interno para distinguir pausa del usuario vs. interrupción del sistema
    this.shouldBePlaying = false;
    this.isInterrupted = false;
    this.userPaused = false;
    this.resumeWatchdog = null;
    this.boundResumeIfInterrupted = null;
    this.boundGestureResume = null;
  }

  // Inicializar el reproductor
  init() {
    this.audioElement = document.getElementById(this.audioElementId);
    this.setupEventListeners();
    return this;
  }

  // Configurar event listeners
  setupEventListeners() {
    // Play button
    const playBtn = document.getElementById(this.playButtonId);
    if (playBtn) {
      playBtn.addEventListener('click', () => this.toggle());
    }

    // Volume slider
    const volumeSlider = document.getElementById(this.volumeSliderId);
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        this.setVolume(e.target.value);
      });
      // Set initial volume
      volumeSlider.value = this.currentVolume;
    }

    // Audio element events
    if (this.audioElement) {
      this.audioElement.addEventListener('loadstart', () => {
        console.log('AudioPlayer: Loading started');
      });

      this.audioElement.addEventListener('canplay', () => {
        console.log('AudioPlayer: Can play');
      });

      this.audioElement.addEventListener('error', (e) => {
        console.error('AudioPlayer: Audio error:', e);
        this.handleError(e);
      });

      this.audioElement.addEventListener('play', () => {
        this.shouldBePlaying = true;
        this.isInterrupted = false;
        this.userPaused = false;
        this.isPlaying = true;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        this.onPlayCallback();
      });

      // Un pause solo cuenta como acción del usuario si vino de pause().
      // Cualquier otro pause (llamada, Siri, segundo plano, alarma) es una
      // interrupción del sistema que debemos recordar para reanudar luego.
      this.audioElement.addEventListener('pause', () => {
        this.isPlaying = false;
        if (this.userPaused) {
          this.shouldBePlaying = false;
          this.isInterrupted = false;
        } else if (this.shouldBePlaying) {
          this.isInterrupted = true;
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
          }
        }
        this.onPauseCallback();
      });

      this.audioElement.addEventListener('stalled', () => {
        console.warn('AudioPlayer: Stream stalled, will retry on resume');
      });

      this.audioElement.addEventListener('ended', () => {
        if (this.shouldBePlaying) {
          this.isInterrupted = true;
          this.resumeIfInterrupted();
        }
      });
    }

    this.boundResumeIfInterrupted = () => this.resumeIfInterrupted();
    document.addEventListener('visibilitychange', this.boundResumeIfInterrupted);
    window.addEventListener('focus', this.boundResumeIfInterrupted);
    window.addEventListener('pageshow', this.boundResumeIfInterrupted);
    window.addEventListener('online', this.boundResumeIfInterrupted);
    if ('onresume' in document) {
      document.addEventListener('resume', this.boundResumeIfInterrupted);
    }

    // iOS puede bloquear play() programático al volver de una llamada.
    // Reintentamos en el primer toque/clic del usuario.
    this.boundGestureResume = () => this.resumeIfInterrupted();
    document.addEventListener('touchend', this.boundGestureResume, { passive: true });
    document.addEventListener('click', this.boundGestureResume);

    this.startResumeWatchdog();
    this.setupMediaSession();
  }

  // Reanudar si el sistema interrumpió la reproducción
  resumeIfInterrupted() {
    const el = this.audioElement;
    if (!el || !this.shouldBePlaying) return;
    if (!el.paused && !el.ended && !this.isInterrupted) return;

    this.isInterrupted = false;
    console.log('AudioPlayer: Reanudando tras interrupción');

    // Una radio en vivo no tiene posición que conservar: si la conexión se
    // cortó (llamada larga / suspensión) hay que reconectar el stream.
    if (el.ended || el.error || el.networkState === 3) {
      this.reconnectStream();
      return;
    }

    const promise = el.play();
    if (promise && promise.catch) {
      promise.catch(err => {
        console.warn('AudioPlayer: No se pudo reanudar, se reintentará al tocar:', err);
        this.isInterrupted = true;
      });
    }
  }

  // Reconectar el stream en vivo (iOS puede dejarlo mudo tras una llamada)
  reconnectStream() {
    const el = this.audioElement;
    if (!el || !this.streamUrl) return;
    try {
      el.src = this.streamUrl;
      el.load();
      if (this.shouldBePlaying) {
        const promise = el.play();
        if (promise && promise.catch) {
          promise.catch(err => {
            console.warn('AudioPlayer: Reintento de reconexión falló:', err);
            this.isInterrupted = true;
          });
        }
      }
    } catch (e) {
      console.warn('AudioPlayer: Reconexión falló:', e);
    }
  }

  // Vigilante: si la página está visible y debería sonar pero el audio está
  // pausado (iOS no siempre dispara visibilitychange/focus), reanudar.
  startResumeWatchdog() {
    this.stopResumeWatchdog();
    this.resumeWatchdog = setInterval(() => {
      const el = this.audioElement;
      if (!el || document.hidden || !this.shouldBePlaying) return;
      if (el.paused) {
        this.isInterrupted = true;
        this.resumeIfInterrupted();
      }
    }, 5000);
  }

  stopResumeWatchdog() {
    if (this.resumeWatchdog) {
      clearInterval(this.resumeWatchdog);
      this.resumeWatchdog = null;
    }
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Radio en vivo',
        artist: 'Streaming en directo',
        album: ''
      });
      navigator.mediaSession.setActionHandler('play',  () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
    } catch (e) {
      console.warn('AudioPlayer: MediaSession setup failed:', e);
    }
  }

  // Establecer URL del stream
  setStreamUrl(url) {
    this.streamUrl = url;
    this.setupMediaSession();
    console.log('AudioPlayer: Stream URL set to:', url);
  }

  // Reproducir
  play() {
    if (!this.audioElement || !this.streamUrl) {
      console.error('AudioPlayer: Cannot play - missing audio element or stream URL');
      return Promise.reject(new Error('Missing audio element or stream URL'));
    }

    if (this.shouldBePlaying && !this.audioElement.paused) {
      return Promise.resolve();
    }

    if (this.audioElement.src !== this.streamUrl) {
      this.audioElement.src = this.streamUrl;
    }
    this.audioElement.volume = this.currentVolume / 100;
    this.shouldBePlaying = true;
    this.isInterrupted = false;
    this.userPaused = false;

    return this.audioElement.play()
      .then(() => {
        console.log('AudioPlayer: Playing successfully');
        this.isPlaying = true;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        this.onPlayCallback();
      })
      .catch(error => {
        console.error('AudioPlayer: Error playing:', error);
        this.handleError(error);
        throw error;
      });
  }

  // Pausar
  pause() {
    if (!this.audioElement) return;

    this.userPaused = true;
    this.shouldBePlaying = false;
    this.isInterrupted = false;
    this.audioElement.pause();
    this.isPlaying = false;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    this.onPauseCallback();
  }

  // Toggle play/pause
  toggle() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  // Ajustar volumen
  setVolume(value) {
    this.currentVolume = value;
    if (this.audioElement) {
      this.audioElement.volume = value / 100;
    }
    this.onVolumeChangeCallback(value);
  }

  // Obtener volumen actual
  getVolume() {
    return this.currentVolume;
  }

  // Verificar si está reproduciendo
  isPlayingNow() {
    return this.isPlaying;
  }

  // Manejar errores
  handleError(error) {
    this.isPlaying = false;
    this.onErrorCallback(error);
  }

  // Destruir el reproductor
  destroy() {
    this.stopResumeWatchdog();

    if (this.boundResumeIfInterrupted) {
      document.removeEventListener('visibilitychange', this.boundResumeIfInterrupted);
      window.removeEventListener('focus', this.boundResumeIfInterrupted);
      window.removeEventListener('pageshow', this.boundResumeIfInterrupted);
      window.removeEventListener('online', this.boundResumeIfInterrupted);
      if ('onresume' in document) {
        document.removeEventListener('resume', this.boundResumeIfInterrupted);
      }
      this.boundResumeIfInterrupted = null;
    }

    if (this.boundGestureResume) {
      document.removeEventListener('touchend', this.boundGestureResume);
      document.removeEventListener('click', this.boundGestureResume);
      this.boundGestureResume = null;
    }

    this.pause();
    if (this.audioElement) {
      this.audioElement.src = '';
    }
  }
}

export default AudioPlayer;
