/*
 * fis
 * http://fis.baidu.com/
 */

'use strict';

// fis release 执行的是release这个模块, 读取项目的配置文件, 完成一些初始化工作, 
// 然后读取文件, 最关键的模块即compile模块.

// 缓存路径
var CACHE_DIR;

// 用于框架调试时禁用缓存
var debugCache = false;

//核心导出模块.
var exports = module.exports = function(file){
    // 判断缓存路径是否存在. 
    // 缓存路径在Mac下/User/$USER/idid-tmp/cache;
    if(!CACHE_DIR){
        fis.log.error('uninitialized compile cache directory.');
    }

    // 文件标准化, fis-kernel/file. 保证返回一个File类型的对象.
    file = fis.file.wrap(file);

    // 判断文件路径合法性, 包括容错win与unix内核不同的文件路径分隔符.
    // fis-kernel/util
    if(!file.realpath){
        error('unable to compile [' + file.subpath + ']: Invalid file realpath.');
    }

    // 编译开始
    fis.log.debug('compile [' + file.realpath + '] start');

    // 触发编译开始事件.
    fis.emitter.emit('compile:start', file);

    // 判断文件的合法性, 包括是否存在, 可否打开,
    // fis自定义了file类型, 对node的file进行了一些扩展, 加入了自己的一些属性和方法.
    // 使用node fs.exist以及path.exist以及statSync三种方法共同确认.
    if(file.isFile()){
        // 判断是否需要编译.
        if(file.useCompile && file.ext && file.ext !== '.'){
            // 对于需要编译的文件, 首先检查缓存
            var cache = file.cache = fis.cache(file.realpath, CACHE_DIR),
                revertObj = {};
            // 如果缓存可用
            // debugCache 用于框架调试时使用
            if(file.useCache && cache.revert(revertObj) && !debugCache){
                // 将缓存内容拿出, 放入file中当做编译后的结果.
                exports.settings.beforeCacheRevert(file);
                file.requires = revertObj.info.requires;
                file.extras = revertObj.info.extras;
                if(file.isText()){
                    revertObj.content = revertObj.content.toString('utf8');
                }
                file.setContent(revertObj.content);
                exports.settings.afterCacheRevert(file);
            } else {
                // 准备进行新的编译.
                exports.settings.beforeCompile(file);

                // 将原始文件拿出.
                file.setContent(fis.util.read(file.realpath));

                // 核心过程, 通过process进行编译处理.
                process(file);

                // 编译后的收尾, 记录本次编译的依赖等.
                exports.settings.afterCompile(file);
                revertObj = {
                    requires : file.requires,
                    extras : file.extras
                };

                //将本次编译结果写入缓存, 以便下次使用.
                cache.save(file.getContent(), revertObj);
            }
        } else {
            // 不需要编译的文件类型直接以文本或二进制的方式读取即可.
            file.setContent(file.isText() ? fis.util.read(file.realpath) : fis.util.fs.readFileSync(file.realpath));
        }
    } else if(file.useCompile && file.ext && file.ext !== '.'){
        // 对于其他类型, 直接尝试进行编译.
        process(file);
    }

    // 为当前的编译署名做标记.
    if(exports.settings.hash && file.useHash){
        // 为文件添加一个不可写的_md5属性.
        // 通过当前文件内容生成这个_md5属性, 
        // 下次检查当前文件缓存是否可用时 是通过此md5进行比较.
        file.getHash();
    }

    // 编译结束
    file.compiled = true;
    fis.log.debug('compile [' + file.realpath + '] end');
    fis.emitter.emit('compile:end', file);

    // 防止资源同时或嵌套使用的锁.
    // 维护了一个embeddedMap, 用来管理当前编译文件.
    // 当前文件结束编译时, 将其在map里面移除, 用来让其他对它有依赖的文件可以进行编译.
    embeddedUnlock(file);

    // 将编译后的文件返回.
    return file;
};

exports.settings = {
    unique   : false,
    debug    : false,
    optimize : false,
    lint     : false,
    test     : false,
    hash     : false,
    domain   : false,
    beforeCacheRevert : function(){},
    afterCacheRevert : function(){},
    beforeCompile : function(){},
    afterCompile : function(){}
};

// 由release命令来调用, 为本次编译传入初始化的参数表.
exports.setup = function(opt){
    // 默认参数
    var settings = exports.settings;

    // 通过外部opt扩展.
    if(opt){
        fis.util.map(settings, function(key){
            if(typeof opt[key] !== 'undefined'){
                settings[key] = opt[key];
            }
        });
    }
    debugCache = opt.parent.args.indexOf('debug') !== -1;

    // 缓存路径.
    CACHE_DIR = 'compile/';

    // 可以通过后缀时间点建立唯一不可替换的缓存..args
    if(settings.unique){
        CACHE_DIR = 'compile_' + Date.now() + '-' + Math.random();
    } else {
        CACHE_DIR += ''
            + (settings.debug    ? 'debug'     : 'release')
            + (settings.optimize ? '-optimize' : '')
            + (settings.hash     ? '-hash'     : '')
            + (settings.domain   ? '-domain'   : '');
    }
    return CACHE_DIR;
};

// 清理缓存
exports.clean = function(name){
    if(name){
        fis.cache.clean('compile/' + name);
    } else if(CACHE_DIR) {
        fis.cache.clean(CACHE_DIR);
    } else {
        fis.cache.clean('compile');
    }
};

// 语法关键字映射. 为后续编译做准备.
// 建立编译的中间产物, 标记一些内容
// 如以源码 <script src="a.js"></script>
// 编译中间物: <script src="<<<uri:a.js>>>"></script>
// 资源定位后: <script src="a_siuh34.js"></script>
var map = exports.lang = (function(){
    var keywords = ['require', 'embed', 'uri', 'dep', 'jsEmbed'],
        LD = '<<<', RD = '>>>',
        qLd = fis.util.escapeReg(LD),
        qRd = fis.util.escapeReg(RD),
        map = {
            reg : new RegExp(
                qLd + '(' + keywords.join('|') + '):([\\s\\S]+?)' + qRd,
                'g'
            )
        };
    keywords.forEach(function(key){
        map[key] = {};
        map[key]['ld'] = LD + key + ':';
        map[key]['rd'] = RD;
    });
    return map;
})();

// 判断是否是inline情况, 需要文本注入.
//"abc?__inline" return true
//"abc?__inlinee" return false
//"abc?a=1&__inline"" return true
function isInline(info){
    return /[?&]__inline(?:[=&'"]|$)/.test(info.query);
}

// 分析注释区域的@require 字段.
//analyse [@require id] syntax in comment
function analyseComment(comment, callback){
    // 解析require语法
    var reg = /(@require\s+)('[^']+'|"[^"]+"|[^\s;!@#%^&*()]+)/g;

    // 针对require语法做包装.
    callback = callback || function(m, prefix, value){
        return prefix + map.require.ld + value + map.require.rd;
    };

    // 内容替换, 生成预处理产物.
    return comment.replace(reg, callback);
}

// 对JavaScript的扩展, 处理js的几种能力问题.
// 分析[@require id], __inline(path) 嵌入资源内容或base64编码的图片, 
// __uri(path) 动态资源的定位, require(path) 定位模块的依赖.
//expand javascript
//[@require id] in comment to require resource
//__inline(path) to embedd resource content or base64 encodings
//__uri(path) to locate resource
//require(path) to require resource
function extJs(content, callback){
    // 一共分了4组, 包含三个捕获组.
    // 第三组捕获了注释, 分别是//注释以及/*注释.
    // 第四组捕获了类型, 以及路径.
    // __uri('a.js') => <<<uri:'a.js'>>>
    // require('a.js') => <<<require:'a.js'>>>
    // __inline('a.js') => <<<jsEmbed:'a.js'>>>
    // -----------------------------
    // "  (?:[^\\"\r\n\f]|\\[\s\S])*" 
    // |  '(?:[^\\'\n\r\f]|\\[\s\S])*'
    // |  (\/\/[^\r\n\f]+ | \/\*[\s\S]*?(?:\*\/|$))
    // |  \b(__inline|__uri|require)\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*')\s*\)/g;
    
    var reg = /"(?:[^\\"\r\n\f]|\\[\s\S])*" |'(?:[^\\'\n\r\f]|\\[\s\S])*'|(\/\/[^\r\n\f]+ | \/\*[\s\S]*?(?:\*\/|$))|\b(__inline|__uri|require)\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*')\s*\)/g;
    
    callback = callback || function(m, comment, type, value){
        if(type){
            // 根据不同类型, 通过前面的map进行包装.
            // 供后续处理.
            switch (type){
                case '__inline':
                    m = map.jsEmbed.ld + value + map.jsEmbed.rd;
                    break;
                case '__uri':
                    m = map.uri.ld + value + map.uri.rd;
                    break;
                case 'require':
                    m = 'require(' + map.require.ld + value + map.require.rd + ')';
                    break;
            }
        } else if(comment){
            // 如果内容是在comment里面引入
            m = analyseComment(comment);
        }
        return m;
    };

    // 返回中间产物.
    return content.replace(reg, callback);
}

//expand css
//[@require id] in comment to require resource
//[@import url(path?__inline)] to embed resource content
//url(path) to locate resource
//url(path?__inline) to embed resource content or base64 encodings
//src=path to locate resource
function extCss(content, callback){
    // 注释捕获组.
    // import语法.
    //    (\/\*[\s\S]*?(?:\*\/|$))
    // |  (?:@import\s+)?\burl\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^)}\s]+)\s*\)(\s*;?)|\bsrc\s*=\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^\s}]+)/g;
    var reg = /(\/\*[\s\S]*?(?:\*\/|$))|(?:@import\s+)?\burl\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^)}\s]+)\s*\)(\s*;?)|\bsrc\s*=\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^\s}]+)/g;
    callback = callback || function(m, comment, url, last, filter){
        if(url){
            // 判断是资源内容注入, 还是位置定位引入.
            var key = isInline(fis.util.query(url)) ? 'embed' : 'uri';
            if(m.indexOf('@') === 0){
                // 对于使用@import语法的.
                if(key === 'embed'){
                    // 注入标记
                    m = map.embed.ld + url + map.embed.rd + last.replace(/;$/, '');
                } else {
                    // 印入标记.
                    m = '@import url(' + map.uri.ld + url + map.uri.rd + ')' + last;
                }
            } else {
                // 如果不是@import方式的语法. 直接url 如background等属性
                m = 'url(' + map[key].ld + url + map[key].rd + ')' + last;
            }
        } else if(filter) {
            // 如果是src引入.
            m = 'src=' + map.uri.ld + filter + map.uri.rd;
        } else if(comment) {
            // 如果是注释中的引入.
            m = analyseComment(comment);
        }
        return m;
    };
    return content.replace(reg, callback);
}


// 扩展HTML, 同JS.
//expand html
//[@require id] in comment to require resource
//<!--inline[path]--> to embed resource content
//<img|embed|audio|video|link|object ... (data-)?src="path"/> to locate resource
//<img|embed|audio|video|link|object ... (data-)?src="path?__inline"/> to embed resource content
//<script|style ... src="path"></script|style> to locate js|css resource
//<script|style ... src="path?__inline"></script|style> to embed js|css resource
//<script|style ...>...</script|style> to analyse as js|css
function extHtml(content, callback){
    // 五个分组, 8个捕获组.
    // 1. script标签内容, 第一个捕获组捕获open_script内容$1, 第二个捕获组捕获js代码$2.
    // 2. style标签内容, 第一个捕获组为open_style内容$3, 第二个捕获组为css代码$4.
    // 3. 图像, 声音等虽有链接替换元素. 捕获元素标签$5.
    // 4. inline 代码.捕获inline内容$6
    // 5. 注释.捕获注释内容$7, $8.
    //     (<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/script\s*>|$)
    // |   (<style(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/style\s*>|$)
    // |   <(img|embed|audio|video|link|object|source)\s+[\s\S]*?["'\s\w\/\-](?:>|$)
    // |   <!--inline\[([^\]]+)\]-->
    // |   <!--(?!\[)([\s\S]*?)(-->|$)/ig;
    var reg = /(<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/script\s*>|$)(<style(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/style\s*>|$)|<(img|embed|audio|video|link|object|source)\s+[\s\S]*?["'\s\w\/\-](?:>|$)|<!--inline\[([^\]]+)\]-->|<!--(?!\[)([\s\S]*?)(-->|$)/ig;
    callback = callback || function(m, $1, $2, $3, $4, $5, $6, $7, $8){
        if($1){//<script>
            var embed = '';
            // 匹配data-src | src.
            // 外链返回src="<<<uri:path>>>"
            $1 = $1.replace(/(\s(?:data-)?src\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(m, prefix, value){
                if(isInline(fis.util.query(value))){
                    embed += map.embed.ld + value + map.embed.rd;
                    return '';
                } else {
                    return prefix + map.uri.ld + value + map.uri.rd;
                }
            });
            if(embed){
                //embed file
                m = $1 + embed;
            } else if(!/\s+type\s*=/i.test($1) || /\s+type\s*=\s*(['"]?)text\/javascript\1/i.test($1)) {
                //without attrubite [type] or must be [text/javascript]
                // 内联js, 使用extJs返回
                m = $1 + extJs($2);
            } else {
                //other type as html
                // script模板, 使用extHtml返回.
                m = $1 + extHtml($2);
            }
        } else if($3){//<style>
            // 内联style, 返回extCss.
            m = $3 + extCss($4);
        } else if($5){//<img|embed|audio|video|link|object|source>
            var tag = $5.toLowerCase();
            // link元素
            if(tag === 'link'){
                var inline = '', isCssLink = false, isImportLink = false;
                var result = m.match(/\srel\s*=\s*('[^']+'|"[^"]+"|[^\s\/>]+)/i);
                if(result && result[1]){
                    var rel = result[1].replace(/^['"]|['"]$/g, '').toLowerCase();
                    isCssLink = rel === 'stylesheet';
                    isImportLink = rel === 'import';
                }
                m = m.replace(/(\s(?:data-)?href\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(_, prefix, value){
                    if((isCssLink || isImportLink) && isInline(fis.util.query(value))){
                        if(isCssLink) {
                            inline += '<style' + m.substring(5).replace(/\/(?=>$)/, '').replace(/\s+(?:charset|href|data-href|hreflang|rel|rev|sizes|target)\s*=\s*(?:'[^']+'|"[^"]+"|[^\s\/>]+)/ig, '');
                        }
                        inline += map.embed.ld + value + map.embed.rd;
                        if(isCssLink) {
                            inline += '</style>';
                        }
                        return '';
                    } else {
                        return prefix + map.uri.ld + value + map.uri.rd;
                    }
                });
                m = inline || m;
            } else if(tag === 'object'){
                // object元素
                m = m.replace(/(\sdata\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(m, prefix, value){
                    return prefix + map.uri.ld + value + map.uri.rd;
                });
            } else {
                // 其他 img等
                m = m.replace(/(\s(?:data-)?src\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(m, prefix, value){
                    var key = isInline(fis.util.query(value)) ? 'embed' : 'uri';
                    return prefix + map[key]['ld'] + value + map[key]['rd'];
                });
                if (tag == 'img') {
                    //<img src="image-src.png" srcset="image-1x.png 1x, image-2x.png 2x, image-3x.png 3x, image-4x.png 4x">
                    //http://www.webkit.org/demos/srcset/
                    m = m.replace(/(\ssrcset\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, function(m, prefix, value){
                        var info = fis.util.stringQuote(value);
                        var set = info.rest.split(',');
                        var imgset = [];
                        set.forEach(function (item) {
                            item = item.trim();
                            var p = item.indexOf(' ');
                            if (p == -1) {
                                imgset.push(item);
                                return;
                            }
                            imgset.push(map['uri']['ld'] + item.substr(0, p) + map['uri']['rd'] + item.substr(p));
                        });
                        return prefix + info.quote + imgset.join(', ') + info.quote;
                    });
                }
            }
        } else if($6){
            // inline内容
            m = map.embed.ld + $6 + map.embed.rd;
        } else if($7){
            // 注释内容
            m = '<!--' + analyseComment($7) + $8;
        }
        return m;
    };
    return content.replace(reg, callback);
}

// 核心编译过程.
function process(file){
    // 预编译, 根据不同的文件属性进行不同的处理.
    // 处理less的编译, ts等类js语言的编译.
    if(file.useParser !== false){
        pipe(file, 'parser', file.ext);
    }    
    if(file.rExt){
        // 预编译.
        if(file.usePreprocessor !== false){
            pipe(file, 'preprocessor', file.rExt);
        }
        // 标准编译处理
        if(file.useStandard !== false){
            standard(file);
        }
        // 编译后处理
        if(file.usePostprocessor !== false){
            pipe(file, 'postprocessor', file.rExt);
        }
        // lint校验
        if(exports.settings.lint && file.useLint !== false){
            pipe(file, 'lint', file.rExt, true);
        }
        // 测试
        if(exports.settings.test && file.useTest !== false){
            pipe(file, 'test', file.rExt, true);
        }
        // 优化
        if(exports.settings.optimize && file.useOptimizer !== false){
            pipe(file, 'optimizer', file.rExt);
        }
    }
}

// 文件流Stream处理, 控制读写平衡, 不会因为单个文件或单个节点的阻塞而影响其他文件的编译.
// 类似于linux中的pipe.
function pipe(file, type, ext, keep){
    var key = type + ext;
    // 通过fis.util方法, 获取fis.config里modules的配置.
    // 通过type取到相应的processor.
    fis.util.pipe(key, function(processor, settings, key){
        settings.filename = file.realpath;
        var content = file.getContent();
        try {
            fis.log.debug('pipe [' + key + '] start');

            // 核心处理过程.
            var result = processor(content, file, settings);

            fis.log.debug('pipe [' + key + '] end');

            // 是否保留原始文件, 默认不保留.
            if(keep){
                file.setContent(content);
            } else if(typeof result === 'undefined'){
                fis.log.warning('invalid content return of pipe [' + key + ']');
            } else {
                file.setContent(result);
            }
        } catch(e) {
            //log error
            fis.log.debug('pipe [' + key + '] fail');
            var msg = key + ': ' + String(e.message || e.msg || e).trim() + ' [' + (e.filename || file.realpath);
            if(e.hasOwnProperty('line')){
                msg += ':' + e.line;
                if(e.hasOwnProperty('col')){
                    msg += ':' + e.col;
                } else if(e.hasOwnProperty('column')) {
                    msg += ':' + e.column;
                }
            }
            msg += ']';
            e.message = msg;
            error(e);
        }
    });
}

var embeddedMap = {};

function error(msg){
    //for watching, unable to exit
    embeddedMap = {};
    fis.log.error(msg);
}

// 是否文件安全检测.
// 防止出现循环嵌套, 查找当前文件和需要embed的文件之间的关系.
function embeddedCheck(main, embedded){
    main = fis.file.wrap(main).realpath;
    embedded = fis.file.wrap(embedded).realpath;

    // 如果当前文件和引入资源文件是同一个文件. 
    if(main === embedded){
        error('unable to embed file[' + main + '] into itself.');
    } else if(embeddedMap[embedded]) {
        // 检测到已经被锁定的依赖
        // 递归添加当前文件的依赖, 依赖中的依赖, 将所有这些资源全部标记出来.
        var next = embeddedMap[embedded],
            msg = [embedded];
        while(next && next !== embedded){
            msg.push(next);
            next = embeddedMap[next];
        }
        msg.push(embedded);
        error('circular dependency on [' + msg.join('] -> [') + '].');
    }

    // 如果没有问题, 加入当前文件标记.
    embeddedMap[embedded] = main;
    return true;
}

function embeddedUnlock(file){
    delete embeddedMap[file.realpath];
}

function addDeps(a, b){
    if(a && a.cache && b){
        if(b.cache){
            a.cache.mergeDeps(b.cache);
        }
        a.cache.addDeps(b.realpath || b);
    }
}

// 标准编译
function standard(file){
    // 获取文件信息.
    var path = file.realpath,
        content = file.getContent();

    // 判断文件内容是否为字符串.
    if(typeof content === 'string'){
        fis.log.debug('standard start');
        //expand language ability
        // 扩展语言能力, 预编译
        if(file.isHtmlLike){
            // html 文件,包括php, tpl等, 文件类型又在file里面列出.
            content = extHtml(content);
        } else if(file.isJsLike){
            // js 文件, 目前仅包括js, jsx, coffee, 在file里面列出.
            content = extJs(content);
        } else if(file.isCssLike){
            // css文件, less, sass等.
            content = extCss(content);
        }

        // 编译替换, 资源定位, 内容嵌入
        content = content.replace(map.reg, function(all, type, value){
            var ret = '', info;
            try {
                // 判断替换类型. 返回ret.
                switch(type){
                    // 模块引用
                    case 'require':
                        info = fis.uri.getId(value, file.dirname);
                        // 为其requires属性[Array]增加一个元素
                        file.addRequire(info.id);
                        ret = info.quote + info.id + info.quote;
                        break;
                    // 动态资源定位
                    case 'uri':
                        // value是当前源文件路径, path.
                        // dirname是文件的父目录, 通过这两个来判断文件是否存在.
                        info = fis.uri(value, file.dirname);
                        if(info.file && info.file.isFile()){
                            // 编译带md5后缀的文件.
                            if(info.file.useHash && exports.settings.hash){
                                // 资源检查, 避免循环引入, 或自我嵌入, 或重复编译.
                                if(embeddedCheck(file, info.file)){
                                    // 递归文件处理
                                    exports(info.file);
                                    addDeps(file, info.file);
                                }
                            }
                            // 处理资源文件的查询参数
                            var query = (info.file.query && info.query) ? '&' + info.query.substring(1) : info.query;
                            var url = info.file.getUrl(exports.settings.hash, exports.settings.domain);
                            var hash = info.hash || info.file.hash;
                            // 拼装资源文件地址.
                            ret = info.quote + url + query + hash + info.quote;
                        } else {
                            // 没有定位, 直接返回路径, 相当于不处理.
                            ret = value;
                        }
                        break;
                    // 模块依赖处理
                    case 'dep':
                        if(file.cache){
                            info = fis.uri(value, file.dirname);
                            addDeps(file, info.file);
                        } else {
                            fis.log.warning('unable to add deps to file [' + path + ']');
                        }
                        break;
                    // 资源嵌入处理
                    case 'embed':
                    case 'jsEmbed':
                        info = fis.uri(value, file.dirname);
                        var f;
                        if(info.file){
                            f = info.file;
                        } else if(fis.util.isAbsolute(info.rest)){
                            f = fis.file(info.rest);
                        }
                        if(f && f.isFile()){
                            if(embeddedCheck(file, f)){
                                exports(f);
                                addDeps(file, f);
                                f.requires.forEach(function(id){
                                    file.addRequire(id);
                                });
                                if(f.isText()){
                                    ret = f.getContent();
                                    if(type === 'jsEmbed' && !f.isJsLike && !f.isJsonLike){
                                        ret = JSON.stringify(ret);
                                    }
                                } else {
                                    ret = info.quote + f.getBase64() + info.quote;
                                }
                            }
                        } else {
                            fis.log.error('unable to embed non-existent file [' + value + ']');
                        }
                        break;
                    default :
                        fis.log.error('unsupported fis language tag [' + type + ']');
                }
            } catch (e) {
                embeddedMap = {};
                e.message = e.message + ' in [' + file.subpath + ']';
                throw  e;
            }
            return ret;
        });
        file.setContent(content);
        fis.log.debug('standard end');
    }
}

exports.extJs = extJs;
exports.extCss = extCss;
exports.extHtml = extHtml;
exports.isInline = isInline;
exports.analyseComment = analyseComment;
