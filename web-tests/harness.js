import {ChatPlayer} from '../js/chat-renderer.js';
const film={title:'An unusually long film title that still needs to fit on a very small screen',year:'2024',rating:null};
// A member with a current rating and one without: a list row and a diary line never invent a score,
// so the card must ask the film registry before printing "Sem nota".
const ratedFilm={...film,title:'A rated member of the list',year:'1999',rating:5};
const stats=[{key:'reviews',label:'reviews',value:86},{key:'share',label:'share',value:.835}];
const script={version:'presentation-v1',opening:{top_four:[film,film,film,film]},events:[
 {type:'typing',duration:'short'},{type:'pause',duration:'short'},
 {type:'message',cue:'top_four_reveal',segments:[{text:'Hello, cinema.'}]},
 {type:'message',role:'archetype_phrase',segments:[{text:'A very long archetype stays alongside four favorite films.'}]},
 {type:'message',segments:[{text:'Questionable',effect:'strike'},{text:'Excellent',effect:'correction'}]},
 {type:'message',segments:[{text:'Antes. '},{text:'"Jack, I swear..." — Ennis Del Mar',effect:'quote'},{text:' Depois.'}]},
 {type:'message',text:'Cru: <blockquote>"Nunca mais."</blockquote> fim.'},
 {type:'strike',text:'Wrong'},{type:'correction',original:'Wrong',replacement:'Right'},
 {type:'profile_stats',stats},{type:'film',film},{type:'film_pair',films:[film,film]},
 {type:'film_group',films:[film,film,film,film]},
 {type:'review_quote',title:'Raw markup',year:'2026',rating:4,text:'Dito isso, de pau duro e triste.<blockquote>"Jack, I swear..." — Ennis Del Mar</blockquote>'},
 {type:'review_quote',...film,segments:[{type:'paragraph',text:'<img src=x onerror=alert(1)>'},{type:'strong',text:'Strong. '},{type:'em',text:'Emphasis.'},{type:'blockquote',text:'A long review. '.repeat(90)}]},
 {type:'tag',tag:'Cinema',related_tag:'Again',stats,films:[film,ratedFilm]},
 {type:'tag_list_relationship',tag:{name:'Tag A'},list:{name:'List A',description:'A synthetic list'},intersection:2,list_count:3,tag_count:2,coverage:2/3,lift:1.5,shared_films:[film,ratedFilm],exceptions:{list_without_tag:[film],tag_without_list:[]}},
 {type:'list',name:'A list',description:'Long description '.repeat(25),films:[film,ratedFilm,film,film],stats},
 {type:'rating',...film},{type:'rewatch',film,sessions:[{rating:5,date:'2025-01-01'},{rating:5,date:'2026-01-01'}],stats},
 {type:'phrase',phrase:'Dito isso',stats},{type:'stat',stats},{type:'future'}
]};
const player=new ChatPlayer(document.querySelector('#chat'),document.querySelector('#bottom'),document.querySelector('#announce'));
player.clock.skip();await player.play(script);document.querySelector('#done').textContent='PASS';
