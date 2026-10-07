import { collisionFor, isShipwreck, transitionDuration } from './collision.js';

const clamp = value => Math.max(0, Math.min(1, value));
const easeRange = (start, end, value) => { const q = clamp((value-start)/(end-start)); return q*q*(3-2*q); };

export class OceanScene {
  constructor(canvas) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.round=null;this.mode='easy';this.motion=null;
    this.sprites={};
    for(const name of ['iceberg','debris']){const img=new Image();img.decoding='async';img.src='/'+name+'.png';this.sprites[name]=img;}
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas);this.resize();
    this.frame=requestAnimationFrame(t=>this.loop(t));
  }
  resize(){const r=this.canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.max(1,Math.round(r.width*d));this.canvas.height=Math.max(1,Math.round(r.height*d));}
  setState(round,mode){this.round=round;this.mode=mode;}
  transition(from,to,type,onImpact=()=>{}){return new Promise(resolve=>{const collision=collisionFor(from,to,type);this.motion={from,to,type,collision,start:performance.now(),duration:transitionDuration(type,collision,this.reduced),onImpact,impactPlayed:false,resolve};this.mode=to.difficulty;});}
  loop(t){
    if(this.motion?.collision&&!this.motion.impactPlayed&&(this.reduced||(t-this.motion.start)/this.motion.duration>=.38)){this.motion.impactPlayed=true;this.motion.onImpact(this.motion.collision.kind);}
    this.draw(t/1000);
    if(this.motion&&t-this.motion.start>=this.motion.duration){const m=this.motion;this.round=m.to;this.motion=null;m.resolve();}
    this.frame=requestAnimationFrame(n=>this.loop(n));
  }
  drawObstacle(kind,x,y,alpha=1){
    const img=this.sprites[kind];if(!img.complete||!img.naturalWidth)return;
    const c=this.ctx;c.save();c.globalAlpha=alpha;
    if(kind==='iceberg')c.drawImage(img,x,y-116,295,225);else c.drawImage(img,x,y-25,143,53);
    c.restore();
  }
  draw(t){
    const c=this.ctx,W=1200,H=400; c.setTransform(this.canvas.width/W,0,0,this.canvas.height/H,0,0);
    const motion=this.motion,p=motion?Math.min(1,(performance.now()-motion.start)/motion.duration):1,e=p*p*(3-2*p);
    const impact=motion?.collision,wreck=isShipwreck(motion?.to||this.round),hit=!!impact&&p>=.38;
    const reaction=hit?clamp((p-.38)/.34):0,sink=wreck&&motion?easeRange(.57,.99,p):wreck?1:0;
    const r=motion?.to||this.round,old=motion?.from,step=r?.step||0,max=r?.maxStops||({easy:19,medium:17,hard:15,expert:10}[this.mode]);
    const travel=motion?.type==='sail'?(old?.step||0)+(step-(old?.step||0))*e:step,progress=travel/max,storm=Math.max(0,(progress-.5)*2),sailing=motion?.type==='sail';
    const dark=this.mode==='expert'?.7:this.mode==='hard'?.35:0,night=Math.min(1,storm+dark);
    const rr=(x,y,w,h,r,fill,stroke)=>{c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill()}if(stroke){c.strokeStyle=stroke;c.lineWidth=1;c.stroke()}};
    const line=(x,y,a,b,color,width=1)=>{c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x,y);c.lineTo(a,b);c.stroke()};
    const poly=(pts,color,stroke)=>{c.beginPath();pts.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=color;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=1;c.stroke()}};
    const circle=(x,y,r,col)=>{c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fillStyle=col;c.fill()};
    const gradient=(y1,y2,stops)=>{let g=c.createLinearGradient(0,y1,0,y2);stops.forEach(([p,col])=>g.addColorStop(p,col));return g};
    c.fillStyle=gradient(0,H,[[0,night>.6?'#192b3e':'#193f53'],[.58,'#153a4c'],[1,'#0a2233']]);c.fillRect(0,0,W,H);
    const glow=c.createRadialGradient(830,80,0,830,80,360);glow.addColorStop(0,night>.5?'#889cba10':'#7ae7d418');glow.addColorStop(1,'#67dfca00');c.fillStyle=glow;c.fillRect(0,0,W,H);
    for(let layer=0;layer<3;layer++){const pts=[[-40,270]];for(let i=0;i<20;i++)pts.push([-50+i*75-travel*1.5*(3-layer),224+layer*16-Math.sin(i*1.2+layer)*18-Math.cos(i*.73)*12]);pts.push([1260,290]);poly(pts,['#245065','#1d4559','#163b50'][layer])}
    c.fillStyle=gradient(265,H,[[0,'#174858'],[1,'#0c2537']]);c.fillRect(0,265,W,135);
    const time=this.reduced?0:t;
    for(let i=0;i<75;i++){const x=((i*149-travel*70-time*(i%3+1)*5)%1260+1260)%1260-30,y=279+i%9*13+Math.sin(time*1.1+i)*(1+storm*2);line(x,y,x+18+i%4*15,y,`rgba(129,218,225,${.035+i%4*.018})`,1.2)}
    function port(x,y,scale){c.save();c.translate(x,y);c.scale(scale,scale);rr(-110,-10,235,17,1,'#274b5b');rr(-90,-53,56,43,2,'#296577');rr(-20,-38,54,28,2,'#2b7080');for(let i=0;i<4;i++)rr(-82+i*10,-43,5,9,1,'#6d99a3');for(let i=0;i<3;i++)rr(-12+i*12,-28,5,8,1,'#71a5a9');line(55,-8,55,-144,'#367d8a',4);line(49,-145,124,-145,'#367d8a',5);line(124,-145,124,-17,'#467a82',2);line(55,-144,108,-112,'#367d8a',2);line(108,-112,108,-22,'#557f8a',2);line(55,-97,108,-112,'#32616f',2);rr(75,-25,45,15,1,'#31828b');rr(-109,8,6,30,0,'#244251');rr(111,8,6,30,0,'#244251');c.globalAlpha=.12;c.scale(1,-.6);rr(-85,-52,110,40,2,'#71a2ac');c.restore()}
    if(progress<.2)port(165-travel*28,294,.65);if(progress>.75)port(1370-(progress-.75)*1000,291,.64);
    for(let i=0;i<26;i++){let x=220+i*220-travel*80;if(x>-40&&x<1240){const y=286+Math.sin(i*1.7)*6;poly([[x-12,y+5],[x+12,y+5],[x+7,y-2],[x-7,y-2]],'#a57d61');line(x,y-2,x,y-26,'#7bafad',2);circle(x,y-29,3,i<travel?'#65e8bd':'#e7bd79')}}
    if(night>.15){c.save();c.filter='blur(14px)';for(let i=0;i<5;i++){c.beginPath();c.ellipse(570+i*160,208+i%2*12,135,28+night*18,0,0,Math.PI*2);c.fillStyle=`rgba(10,21,41,${night*.13})`;c.fill()}c.restore();if(storm>.3)for(let i=0;i<32;i++){const x=520+(i*47+time*78)%750,y=225+(i*29+time*92)%150;line(x,y,x-3,y+9,'#bbd9e012')}}
    const shipX=690+Math.sin(travel*.3)*19,shipY=306+Math.sin(time*2.2)*(2+storm*3);
    const approach=impact?easeRange(0,.38,p):1,obstacleX=shipX+177+(1-approach)*360;
    if(impact){
      const passing=impact.kind==='debris'?easeRange(.56,1,p):0;
      this.drawObstacle(impact.kind,obstacleX-passing*385,shipY+18,impact.kind==='debris'?1-passing*.7:1);
    }else if(wreck)this.drawObstacle('iceberg',shipX+177,shipY+18,.9);
    const shake=this.reduced?0:Math.sin(reaction*32)*Math.pow(1-reaction,2)*(impact?.kind==='iceberg'?11:4);
    const roll=this.reduced?0:impact?.kind==='iceberg'?Math.sin(reaction*Math.PI)*.065+sink*.2:impact?Math.sin(reaction*Math.PI*2)*.027*(1-reaction):0;
    c.save();
    if(wreck){c.beginPath();c.rect(0,0,W,355);c.clip();}
    c.translate(shipX+shake,shipY+sink*250+(hit&&!this.reduced?Math.sin(reaction*Math.PI)*(wreck?8:4):0));c.rotate(Math.sin(time*2.2)*(.003+storm*.009)+roll);c.save();c.scale(1,.12);const shadow=c.createRadialGradient(0,340,0,0,340,230);shadow.addColorStop(0,'#04101eaa');shadow.addColorStop(1,'#04101e00');c.fillStyle=shadow;c.fillRect(-260,90,520,500);c.restore();
    if(sailing)for(let i=0;i<7;i++){const q=(time*1.9+i*.16)%1;c.globalAlpha=(1-q)*.25;c.strokeStyle='#9cefe4';c.lineWidth=2;c.beginPath();c.ellipse(-195-q*90,33+q*6,22+q*54,3+q*6,0,0,Math.PI*2);c.stroke()}c.globalAlpha=1;
    poly([[-182,0],[207,0],[176,44],[-151,44],[-175,25]],gradient(0,45,[[0,'#3d91a0'],[.48,'#24677b'],[1,'#143d50']]),'#4c91a1');poly([[-159,-23],[170,-23],[207,0],[-182,0]],'#467e89','#7eaaa9');line(-174,10,192,10,'#9bc6c3',2);line(-162,29,180,29,'#072b3e',4);c.fillStyle='#a1c5cd';c.font='700 9px Segoe UI';c.fillText('C A R G O',-123,24);for(let i=0;i<6;i++)circle(-17+i*24,21,3,'#97b1ae');
    rr(-163,-75,61,51,4,'#689ca5','#8fb5b6');poly([[-168,-76],[-105,-76],[-96,-87],[-155,-87]],'#8bb8b9');poly([[-102,-75],[-94,-86],[-94,-32],[-102,-25]],'#375f6f');rr(-154,-67,42,14,2,gradient(-67,-53,[[0,'#7de1dc'],[1,'#378590']]));line(-133,-67,-133,-53,'#74a1a5',2);rr(-151,-46,8,14,2,'#426e7b');rr(-125,-44,15,14,2,'#447782');rr(-145,-103,13,18,1,'#70939a');rr(-146,-105,15,4,1,'#8aadb0');line(-104,-87,-104,-117,'#74b8bc',2);circle(-104,-121,3,'#61e8bd');
    for(let i=0;i<4;i++){const q=(time*.45+i*.25)%1;circle(-140-q*27,-114-q*30,6+q*11,`rgba(161,194,206,${.065*(1-q)})`)}
    const colors=['#5ce6bb','#edc175','#a99be9'];
    for(let i=0;i<3;i++){
      const id=['A','B','C'][i],cur=r?.containers?.[i],prior=old?.containers?.[i],changed=motion&&prior?.status==='onboard'&&cur?.status!=='onboard';
      if(cur&&cur.status!=='onboard'&&!changed)continue;
      let x=-76+i*79,y=-24,alpha=1,rotation=0;
      if(changed){const q=motion.type==='sail'?easeRange(impact?.kind==='iceberg' ? .44 : .47,.85,p):e;if(cur.status==='lost'){x+=(i-1)*q*22;y+=q*114;rotation=q*(i===1?-.23:.24);alpha=1-q;}else{x+=i===0?-q*240:q*240;y-=Math.sin(q*Math.PI)*90;alpha=1-q}}
      c.save();c.globalAlpha=alpha;c.translate(x,y);c.rotate(rotation);const col=colors[i];rr(0,-44,68,44,2,col+'bc',col);poly([[0,-44],[11,-56],[79,-56],[68,-44]],col+'dd');poly([[68,-44],[79,-56],[79,-12],[68,0]],col+'82');for(let j=0;j<8;j++)line(7+j*7,-40,7+j*7,-5,'#12384444',1.4);rr(25,-32,21,24,3,'#07323966');c.textAlign='center';c.font='700 16px Segoe UI';c.fillStyle='#ecfbf8';c.fillText(id,35,-15);c.textAlign='left';c.restore();
    }
    line(-181,-6,203,-6,'#b0c7c3',1.5);for(let i=0;i<15;i++)line(-176+i*25,-7,-176+i*25,-19,'#93b7b8',1);line(-176,-19,175,-19,'#b0c9c6',1);c.restore();
    if(hit&&!this.reduced){
      const burst=clamp((p-.38)/.35),count=impact.kind==='iceberg'?28:12;
      c.save();c.globalAlpha=(1-burst)*.9;
      for(let i=0;i<count;i++){const angle=-Math.PI*.85+i/count*Math.PI*.72,speed=30+(i*29%97),x=shipX+190+Math.cos(angle)*speed*burst,y=shipY+14+Math.sin(angle)*speed*burst+burst*burst*35;circle(x,y,1.7+i%3,impact.kind==='iceberg'?'#c9f9ff':'#96e0d7');}
      c.strokeStyle='#c8f5f5';c.lineWidth=2;c.beginPath();c.ellipse(shipX+190,shipY+31,15+burst*98,4+burst*18,0,0,Math.PI*2);c.stroke();c.restore();
    }
    if(motion?.type==='sail'&&impact&&p>.57){for(let i=0;i<3;i++)if(old?.containers[i]?.status==='onboard'&&r?.containers[i]?.status==='lost'){const q=clamp((p-.57)/.43),x=shipX-40+i*79;c.globalAlpha=(1-q)*.8;c.strokeStyle='#7dcfe1';c.beginPath();c.ellipse(x,shipY+42,15+q*40,4+q*8,0,0,Math.PI*2);c.stroke();c.globalAlpha=1}}
    if(wreck&&sink>.35){
      c.save();c.strokeStyle='#80d4e5';c.globalAlpha=motion ? .35 : .14;c.lineWidth=1.5;
      for(let i=0;i<7;i++){const q=(time*.45+i*.14)%1;c.beginPath();c.arc(shipX-80+i*30,361-q*28,2+q*3,0,Math.PI*2);c.stroke();}
      c.beginPath();c.ellipse(shipX+5,354,140,10+Math.sin(time)*2,0,0,Math.PI*2);c.stroke();c.restore();
    }
    c.fillStyle=gradient(330,400,[[0,'#0a223300'],[1,'#0a2233e0']]);c.fillRect(0,330,W,70);
  }
}
