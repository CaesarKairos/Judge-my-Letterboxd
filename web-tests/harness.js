import {ChatPlayer} from '../js/chat-renderer.js';
const film={title:'An unusually long film title that still needs to fit on a very small screen',year:'2024',rating:null};
const stats=[{key:'reviews',label:'reviews',value:86},{key:'share',label:'share',value:.835}];
const script={version:'presentation-v1',opening:{top_four:[film,film,film,film]},events:[
 {type:'typing',duration:'short'},{type:'pause',duration:'short'},
 {type:'message',cue:'top_four_reveal',segments:[{text:'Hello, cinema.'}]},
 {type:'message',role:'archetype_phrase',segments:[{text:'A very long archetype stays alongside four favorite films.'}]},
 {type:'message',segments:[{text:'Questionable',effect:'strike'},{text:'Excellent',effect:'correction'}]},
 {type:'strike',text:'Wrong'},{type:'correction',original:'Wrong',replacement:'Right'},
 {type:'profile_stats',stats},{type:'film',film},{type:'film_pair',films:[film,film]},
 {type:'film_group',films:[film,film,film,film]},
 {type:'review_quote',...film,segments:[{type:'paragraph',text:'<img src=x onerror=alert(1)>'},{type:'strong',text:'Strong. '},{type:'em',text:'Emphasis.'},{type:'blockquote',text:'A long review. '.repeat(90)}]},
 {type:'tag',tag:'Cinema',related_tag:'Again',stats,films:[film]},
 {type:'list',name:'A list',description:'Long description '.repeat(25),films:[film,film,film],stats},
 {type:'rating',...film},{type:'rewatch',film,sessions:[{rating:5,date:'2025-01-01'},{rating:5,date:'2026-01-01'}],stats},
 {type:'phrase',phrase:'Dito isso',stats},{type:'stat',stats},{type:'future'}
]};
const player=new ChatPlayer(document.querySelector('#chat'),document.querySelector('#bottom'),document.querySelector('#announce'));
player.clock.skip();await player.play(script);document.querySelector('#done').textContent='PASS';
