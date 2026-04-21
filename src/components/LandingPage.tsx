import React from 'react';
import { motion } from 'motion/react';
import { FileText, Tags, Search, Sparkles, MoveRight, Layers, FileSearch, ArrowRight, Shield, BookOpen, Quote, MousePointer2, ChevronRight, Play } from 'lucide-react';

interface LandingPageProps {
  onNavigate: (view: 'login' | 'signup') => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onNavigate }) => {
  return (
    <div className="min-h-screen bg-[#0A0A0B] text-slate-200 font-sans overflow-x-hidden selection:bg-blue-500/30 selection:text-white">
      {/* Background Atmosphere */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-blue-600/10 rounded-full blur-[160px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-600/50 rounded-full blur-[140px] opacity-20" />
      </div>

      <div className="relative z-10">
        {/* Navigation */}
        <nav className="sticky top-0 w-full bg-[#0A0A0B]/80 backdrop-blur-xl border-b border-white/5 px-6 py-4 flex items-center justify-between z-50">
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="w-[34px] h-[34px] bg-[#1a66ff] rounded-[10px] flex items-center justify-center transition-transform group-hover:scale-105">
              <Sparkles className="w-[18px] h-[18px] text-white" />
            </div>
            <span className="text-[19px] font-bold tracking-tight text-white ml-0.5">NoteStack</span>
          </div>
          <div className="flex items-center gap-5">
            <button
              onClick={() => onNavigate('login')}
              className="text-[14.5px] font-medium text-slate-400 hover:text-white transition-colors tracking-tight"
            >
              Sign in
            </button>
            <button
              onClick={() => onNavigate('signup')}
              className="text-[13.5px] font-bold bg-white text-black px-4 py-[7px] rounded-full hover:bg-slate-200 transition-colors tracking-tight"
            >
              Get Started
            </button>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="max-w-7xl mx-auto px-6 pt-24 pb-32 grid grid-cols-1 lg:grid-cols-2 gap-20 items-center">
          <div className="max-w-2xl">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[12px] font-bold uppercase tracking-widest mb-8"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              Intelligence Reimagined
            </motion.div>
            
            <motion.h1 
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="text-[54px] md:text-[105px] font-black text-white leading-[0.8] mb-8 tracking-tighter"
            >
              Master your <br/><span className="text-blue-500">Knowledge.</span>
            </motion.h1>
            
            <motion.p 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="text-xl text-slate-400 leading-relaxed mb-10 max-w-lg"
            >
              The ultimate workspace for your research. Sync documents, extract insights, and converse with your data in a seamless, dark-optimized environment.
            </motion.p>
            
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="flex flex-wrap items-center gap-5"
            >
              <button
                onClick={() => onNavigate('signup')}
                className="group flex items-center gap-3 bg-blue-600 text-white px-8 py-4 rounded-2xl font-bold shadow-2xl shadow-blue-500/20 transition-all hover:bg-blue-500 hover:scale-105 active:scale-95"
              >
                Create your first stack <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </button>
              <button className="flex items-center gap-2.5 px-6 py-4 rounded-2xl font-bold text-slate-300 hover:text-white hover:bg-white/5 transition-all">
                <div className="w-8 h-8 rounded-full bg-white/10 border border-white/10 flex items-center justify-center">
                  <Play className="w-3.5 h-3.5 fill-white text-white" />
                </div>
                View Demo
              </button>
            </motion.div>
          </div>

          {/* Interactive UI Mockup - Dark Mode */}
          <div className="relative hidden lg:block h-[600px]">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 1, delay: 0.4, ease: [0.23, 1, 0.32, 1] }}
              className="absolute inset-0 bg-[#0A0A0B] rounded-3xl border border-white/10 shadow-[0_32px_128px_-16px_rgba(0,0,0,1)] overflow-hidden"
            >
              {/* Fake UI Header */}
              <div className="h-14 border-b border-white/5 flex items-center px-6 justify-between bg-white/[0.02]">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/20 border border-red-500/10" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/20 border border-amber-500/10" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/20 border border-emerald-500/10" />
                </div>
                <div className="w-32 h-6 bg-white/5 border border-white/5 rounded-full" />
                <div className="w-8 h-8 rounded-full bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.4)]" />
              </div>
              
              {/* Fake UI Layout */}
              <div className="flex h-full pb-14">
                <div className="w-1/4 border-r border-white/5 p-4 space-y-3 pt-8 bg-black/40">
                  <div className="w-full h-9 bg-blue-600/10 rounded-xl flex items-center px-3 gap-2 border border-blue-500/20">
                    <FileText className="w-3.5 h-3.5 text-blue-500" />
                    <div className="w-16 h-1.5 bg-blue-400/40 rounded-full" />
                  </div>
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className="w-full h-9 rounded-xl flex items-center px-3 gap-2 transition-colors">
                      <FileText className="w-3.5 h-3.5 text-slate-700" />
                      <div className="w-20 h-1 bg-slate-800 rounded-full" />
                    </div>
                  ))}
                </div>
                <div className="flex-1 p-8 space-y-8 pt-12 relative">
                  <motion.div 
                    animate={{ x: [0, 5, 0] }}
                    transition={{ duration: 4, repeat: Infinity }}
                    className="w-2/3 p-5 bg-white/[0.03] border border-white/5 rounded-[2rem] space-y-3"
                  >
                    <div className="w-1/4 h-1.5 bg-slate-600 rounded-full" />
                    <div className="w-full h-1.5 bg-slate-800 rounded-full" />
                    <div className="w-5/6 h-1.5 bg-slate-800 rounded-full" />
                  </motion.div>
                  <motion.div 
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 1 }}
                    className="w-4/5 p-6 ml-auto bg-blue-600 rounded-[2rem] rounded-tr-md flex items-center gap-4 shadow-2xl shadow-blue-500/20 border border-blue-400/30"
                  >
                    <div className="flex-1 space-y-2">
                       <div className="w-full h-2 bg-white/30 rounded-full" />
                       <div className="w-2/3 h-2 bg-white/20 rounded-full" />
                    </div>
                    <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                      <Sparkles className="w-5 h-5 text-white" />
                    </div>
                  </motion.div>

                  {/* Bubble Sparkle Decor */}
                  <div className="absolute bottom-10 left-10 w-24 h-24 bg-blue-500/10 rounded-full blur-3xl" />
                </div>
              </div>

              {/* Floaters */}
              <motion.div 
                animate={{ y: [-10, 10, -10] }}
                transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
                className="absolute top-24 -right-12 w-56 p-5 bg-[#18181A] rounded-[2rem] border border-white/10 shadow-2xl flex items-center gap-4 backdrop-blur-xl"
              >
                <div className="w-12 h-12 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
                  <Quote className="w-6 h-6 text-orange-500" />
                </div>
                <div className="flex-1 space-y-2">
                  <div className="w-24 h-1.5 bg-slate-600 rounded-full" />
                  <div className="w-16 h-1.5 bg-slate-800 rounded-full" />
                </div>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Features Bento */}
        <section className="bg-black/40 py-32 border-y border-white/5">
           <div className="max-w-7xl mx-auto px-6">
              <div className="text-center mb-24">
                 <h2 className="text-5xl font-black text-white mb-6 tracking-tighter">Engineered for Focus.</h2>
                 <p className="text-slate-400 max-w-xl mx-auto text-lg leading-relaxed">Ditch the distractions. NoteStack provides a sanctuary for your documents and thoughts.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                 <div className="md:col-span-8 bg-[#111112] rounded-[32px] border border-white/5 p-12 relative overflow-hidden group">
                    <div className="relative z-10 max-w-sm">
                       <h3 className="text-2xl font-bold text-white mb-4">Grounded Analysis</h3>
                       <p className="text-slate-400 leading-relaxed">Unlike public LLMs, we only use your provided context. This eliminates hallucinations and ensures 100% verified answers.</p>
                    </div>
                    {/* Abstract Grid Visual */}
                    <div className="absolute right-[-10%] bottom-[-10%] w-2/3 h-2/3 bg-blue-600/5 rounded-full blur-[80px]" />
                 </div>

                 <div className="md:col-span-4 bg-white text-black rounded-[32px] p-12 flex flex-col justify-between transition-transform hover:scale-[1.02]">
                    <div className="space-y-6">
                       <div className="w-14 h-14 bg-black rounded-2xl flex items-center justify-center">
                          <Layers className="w-7 h-7 text-white" />
                       </div>
                       <h3 className="text-3xl font-black tracking-tighter">50 Sources. <br/>One AI.</h3>
                       <p className="text-black/60 font-medium">Connect multiple documents into a single unified knowledge base.</p>
                    </div>
                 </div>

                 <div className="md:col-span-4 bg-blue-600 rounded-[32px] p-12 text-white flex flex-col justify-between group cursor-default shadow-2xl shadow-blue-900/20">
                    <h3 className="text-2xl font-bold leading-tight">Instant Citation Map</h3>
                    <div className="space-y-4 py-8">
                       {[1,2,3].map(i => (
                          <div key={i} className="h-1 bg-white/20 rounded-full w-full relative overflow-hidden">
                             <motion.div 
                              initial={{ left: "-100%" }}
                              whileInView={{ left: "100%" }}
                              transition={{ duration: 3, repeat: Infinity, delay: i * 0.5 }}
                              className="absolute top-0 bottom-0 w-1/3 bg-white/40" 
                             />
                          </div>
                       ))}
                    </div>
                    <p className="text-blue-100/70 text-sm">Every paragraph is tracked back to its source file and page.</p>
                 </div>

                 <div className="md:col-span-8 bg-[#111112] border border-white/5 rounded-[32px] p-12 flex flex-col md:flex-row items-center gap-12 text-white group overflow-hidden">
                    <div className="flex-1 space-y-4">
                       <div className="inline-flex px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-xs font-bold tracking-widest uppercase">Safe & Sound</div>
                       <h3 className="text-3xl font-bold">Local-First Privacy</h3>
                       <p className="text-slate-400">Your documents stay within your session. We respect your research privacy with advanced temporary persistence.</p>
                    </div>
                    <Shield className="w-32 h-32 text-slate-800 transition-colors group-hover:text-blue-500/20" />
                 </div>
              </div>
           </div>
        </section>

        {/* CTA */}
        <section className="py-32 px-6 relative overflow-hidden border-t border-white/5 bg-[#0a0a0b]">
           <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-blue-600/10 rounded-full blur-[120px] pointer-events-none" />
           <div className="max-w-7xl mx-auto relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-12">
              <div>
                 <div className="text-[11px] font-bold tracking-widest uppercase text-blue-500 mb-6">Take Control</div>
                 <h2 className="text-5xl md:text-[80px] font-black text-slate-500 mb-2 tracking-tighter leading-[0.9]">Stop searching.</h2>
                 <h2 className="text-5xl md:text-[80px] font-black text-white tracking-tighter leading-[0.9]">Start researching.</h2>
              </div>
              <div className="flex flex-col items-start md:items-end gap-6 md:pl-12 md:border-l border-white/10 mt-8 md:mt-0">
                 <p className="text-slate-400 text-lg left-1 md:text-right max-w-sm">Join thousands of researchers who have upgraded their knowledge stack.</p>
                 <button
                  onClick={() => onNavigate('signup')}
                  className="group relative inline-flex items-center gap-4 bg-white text-black px-8 py-5 rounded-full font-bold text-lg transition-transform hover:scale-105 active:scale-95"
                 >
                    Get Access Now
                    <div className="w-8 h-8 bg-black rounded-full flex items-center justify-center group-hover:translate-x-1 transition-transform">
                       <ArrowRight className="w-4 h-4 text-white" />
                    </div>
                 </button>
              </div>
           </div>
        </section>

        {/* Footer */}
        <footer className="max-w-7xl mx-auto px-6 py-16 border-t border-white/5 flex flex-col md:flex-row items-center justify-between text-slate-500 gap-10">
           <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-blue-500" />
              <span className="text-xl font-bold text-white tracking-tighter">NoteStack</span>
           </div>

           <div className="text-xs font-mono">
              © 2026 NoteStack
           </div>
        </footer>
      </div>
    </div>
  );
};
