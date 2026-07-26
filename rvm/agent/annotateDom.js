([interactiveElementCount, debug, stripDevinId]) => {
    // ONLY MODIFY THE INSIDE OF THIS FUNCTION. THE CONTENTS OF THIS FILE ARE
    // INJECTED INTO A PLAYWRIGHT EVALUATION.
    //
    // stripDevinId (optional, default false): when truthy, the devinid
    // attribute is still assigned internally (so simplification/structure is
    // unchanged) but omitted from the serialized output. Used by computer-use,
    // which acts by screen coordinates and never clicks by devinid.
    //
    // This is the canonical copy of annotateDom.js. It is also embedded at
    // compile time by the following Rust crates via include_str!:
    //   - apps/chisel/toolbox (chisel browser tool)
    //   - apps/devin/devin-rs/remote (computer-use CDP bridge)

    // We need this because `element instanceof HTMLElement` doesn't always work.
    const isElement = (element) => {
        return (
            typeof element.getAttribute === "function" &&
            typeof element.setAttribute === "function" &&
            typeof element.hasAttribute === "function" &&
            typeof element.removeAttribute === "function" &&
            typeof element.matches === "function" &&
            typeof element.cloneNode === "function"
        );
    }

    const tagName = (element) => {
        try {
            return Object.getOwnPropertyDescriptor(Element.prototype, 'tagName').get.call(element);
        } catch (e) {
            try {
                if (element.tagName) {
                    return element.tagName;
                }
            } catch (e) {}
            try {
                if (element.nodeName) {
                    return element.nodeName;
                }
            } catch (e) {}
            return "";
        }
    }

    const isIframe = (element) => {
        return isElement(element) && (element.matches("iframe") || element.matches("frame"));
    }

    const isAnchorLinkInSamePage = (element) => {
        if (!element.getAttribute || tagName(element) !== 'A') {
            return false;
        }

        // Use the current location as the base for comparison
        const baseLocation = window.location;

        // Check if the element's href is an anchor link:
        // 1. The hostname, protocol, and port of the link and base location must match
        // 2. The pathname must match or the link pathname must be empty (for anchors on the same page)
        // 3. The link must have a hash (anchor) component
        return element.hostname === baseLocation.hostname &&
            element.protocol === baseLocation.protocol &&
            element.port === baseLocation.port &&
            (element.pathname === baseLocation.pathname || element.pathname === '') &&
            element.hash !== '';
    }

    // Remove target attributes from all links so that they don't open in new tabs.
    for (const link of document.querySelectorAll("a")) {
        link.removeAttribute("target");
    }

    let tentativeInteractiveElementCount = interactiveElementCount;
    const idToElementMap = new Map();

    const boundingRectZero = (element, depth = 0) => {
        if (depth > 50) {
            return false;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width !== 0 || rect.height !== 0) {
            return false;
        }
        const children = [];

        if (element.shadowRoot !== null) {
            for (const child of element.shadowRoot.children) {
                children.push(child)
            }
        }
        for (const child of element.children) {
            children.push(child);
        }

        for (const child of children) {
            if (!boundingRectZero(child, depth + 1)) {
                return false;
            }
        }
        if (element.matches("option, input")) {
            return false;
        }
        return true;
    }

    const getChildNodes = (element) => {
        const childNodes = [];
        if (element.shadowRoot !== null) {
            for (const childNode of element.shadowRoot.childNodes) {
                childNodes.push(childNode);
            }
        }
        for (const childNode of element.childNodes) {
            childNodes.push(childNode);
        }
        return childNodes;
    }

    // Mark nodes that should be hidden.
    const markHidden = (element, depth = 0, hideBecauseOfParent = false) => {
        if (depth > 500) {
            return false;
        }
        if (!element) {
            return false;
        }
        if (element.nodeType === Node.ELEMENT_NODE) {
            const childNodes = getChildNodes(element);
            const style = window.getComputedStyle(element);
            if (
                isAnchorLinkInSamePage(element) ||
                element.matches("script, style, link, meta, head, title, noscript") ||
                (element.matches("details:not([open]) *:not(summary)"))
            ) {
                element.setAttribute("devin-hidden", "true");
                if (debug) {
                    if (isAnchorLinkInSamePage(element)) {
                        element.setAttribute("devin-hidden-reason", "anchor_link_in_same_page");
                    } else if (element.matches("script, style, link, meta, head, title, noscript")) {
                        element.setAttribute("devin-hidden-reason", "head_related");
                    } else if (element.matches("details:not([open]) *:not(summary)")) {
                        element.setAttribute("devin-hidden-reason", "details_not_open");
                    }
                }
                return true;
            } else if (
                style.display === "none" ||
                style.opacity === "0" ||
                hideBecauseOfParent
            ) {
                // In this clause, children elements cannot override these reasons for
                // being hidden, so we don't need to check all children.
                element.setAttribute("devin-hidden", "true");
                if (debug) {
                    if (style.display === "none") {
                        element.setAttribute("devin-hidden-reason", "display_none");
                    } else if (hideBecauseOfParent) {
                        element.setAttribute("devin-hidden-reason", "hide_because_of_parent");
                    }
                }
                for (const child of childNodes) {
                    markHidden(child, depth + 1, true);
                }
                return true;
            } else if (
                style.visibility === "hidden" ||
                style.width === "0" ||
                style.height === "0" ||
                boundingRectZero(element)
            ) {
                // In this clause, children elements can override these reasons for
                // being hidden, so we need to check all children.
                let allHidden = true;
                for (const child of childNodes) {
                    allHidden &&= markHidden(child, depth + 1);
                }
                if (allHidden) {
                    element.setAttribute("devin-hidden", "true");
                    if (debug) {
                        if (style.visibility === "hidden") {
                            element.setAttribute("devin-hidden-reason", "visibility_hidden");
                        } else if (style.opacity === "0") {
                            element.setAttribute("devin-hidden-reason", "opacity_0");
                        } else if (style.width === "0") {
                            element.setAttribute("devin-hidden-reason", "width_0");
                        } else if (style.height === "0") {
                            element.setAttribute("devin-hidden-reason", "height_0");
                        } else if (boundingRectZero(element)) {
                            element.setAttribute("devin-hidden-reason", "bounding_rect_zero");
                        }
                    }
                    return true;
                }
            }
            element.removeAttribute("devin-hidden");
            element.removeAttribute("devin-hidden-reason");
            for (const child of childNodes) {
                markHidden(child, depth + 1);
            }
            return false;
        } else {
            return true;
        }
    };
    markHidden(document.documentElement);

    const isScrollable = (element) => {
        if (!element || !isElement(element)) return false;

        const style = window.getComputedStyle(element);
        const hasScrollableStyle = ['auto', 'scroll'].includes(style.overflowY) ||
                                 ['auto', 'scroll'].includes(style.overflowX);

        const hasScrollableContent = element.scrollHeight > element.clientHeight ||
                                   element.scrollWidth > element.clientWidth;

        return hasScrollableStyle && hasScrollableContent;
    }

    const isInViewport = (rect) => {
        return rect.bottom >= 0 &&
               rect.right >= 0 &&
               rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
               rect.left <= (window.innerWidth || document.documentElement.clientWidth);
    }

    const getRectIntersection = (rect1, rect2) => {
        const left = Math.max(rect1.left, rect2.left);
        const top = Math.max(rect1.top, rect2.top);
        const right = Math.min(rect1.right, rect2.right);
        const bottom = Math.min(rect1.bottom, rect2.bottom);
        const width = right - left;
        const height = bottom - top;
        if (width <= 0 || height <= 0) {
            return {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                width: 0,
                height: 0
            }
        }
        return {
            left: left,
            top: top,
            right: right,
            bottom: bottom,
            width: width,
            height: height
        };
    }

    // Mark the frontier of nodes that are offscreen or otherwise not visible
    const markOffscreen = (element, depth = 0, parentInfo = null) => {
        if (depth > 50 || !element || !isElement(element) || element.nodeType !== Node.ELEMENT_NODE || element.getAttribute("devin-hidden") === "true") {
            return true;
        }
        const style = window.getComputedStyle(element);
        const isFixedOrSticky = style.position === 'fixed' || style.position === 'sticky';

        let rect = element.getBoundingClientRect();
        if (!isFixedOrSticky && parentInfo && parentInfo.clipRect) {
            rect = getRectIntersection(rect, parentInfo.clipRect);
        }

        const isInvisible = style.visibility !== 'visible' && (style.visibility === 'hidden' || (parentInfo && parentInfo.isInvisible));
        const hasOverflowClip = ['hidden', 'scroll', 'auto'].some(value => [style.overflow, style.overflowX, style.overflowY].includes(value));

        const currentElementInfo = {
            clipRect: hasOverflowClip ? rect : (parentInfo && parentInfo.clipRect),
            isInvisible: isInvisible
        };

        let zeroSize = (rect.width === 0 || rect.height === 0); // dont bother to exclude options and inputs because this is just optional information, and its fine if they have offscreen attr when they are still technically usable
        let isOffscreen = zeroSize || !isInViewport(rect) || isInvisible;
        const children = getChildNodes(element);
        for (const child of children) {
            const childIsOffscreen = markOffscreen(child, depth + 1, currentElementInfo);
            isOffscreen &&= childIsOffscreen;
        }
        if (isOffscreen) {
            element.setAttribute("offscreen", "");
        } else {
            element.removeAttribute("offscreen");
        }
        return isOffscreen;
    };
    markOffscreen(document.documentElement);

    // Mark nodes that are interactible.
    const traverse = (element, depth = 0) => {
        if (depth > 500) {
            return false;
        }
        if (!element) {
            return false;
        }
        if (element.nodeType === Node.ELEMENT_NODE) {
            const style = window.getComputedStyle(element);
            const parentStyle = element.parentElement ? window.getComputedStyle(element.parentElement) : null;
            const pointerNotInherited = style.cursor === "pointer" && (!parentStyle || parentStyle.cursor !== "pointer");
            const hidden = element.getAttribute("devin-hidden") === "true";
            const scrollable = isScrollable(element);
            if (
                !hidden &&
                (
                    element.matches(
                        "a, button, input, select, textarea, img, [contenteditable='true']",
                    ) ||
                    element.hasAttribute("onclick") ||
                    element.hasAttribute("mousedown") ||
                    element.hasAttribute("keydown") ||
                    element.hasAttribute("download") ||
                    element.hasAttribute("tabindex") ||
                    element.hasAttribute("contenteditable") ||
                    pointerNotInherited ||
                    scrollable
                )
            ) {
                if (debug) {
                    if (element.matches("a, button, input, select, textarea, [contenteditable='true']")) {
                        element.setAttribute("devinid-reason", "matches");
                    } else if (element.hasAttribute("onclick")) {
                        element.setAttribute("devinid-reason", "onclick");
                    } else if (element.hasAttribute("mousedown")) {
                        element.setAttribute("devinid-reason", "mousedown");
                    } else if (element.hasAttribute("keydown")) {
                        element.setAttribute("devinid-reason", "keydown");
                    } else if (element.hasAttribute("download")) {
                        element.setAttribute("devinid-reason", "download");
                    } else if (element.hasAttribute("tabindex")) {
                        element.setAttribute("devinid-reason", "tabindex");
                    } else if (element.hasAttribute("contenteditable")) {
                        element.setAttribute("devinid-reason", "contenteditable");
                    } else if (pointerNotInherited) {
                        element.setAttribute("devinid-reason", "cursor_pointer");
                    } else if (isScrollable(element)) {
                        element.setAttribute("devinid-reason", "scrollable");
                    }
                }
                element.setAttribute("devinid", tentativeInteractiveElementCount++);
                element.setAttribute("devin-tagName", tagName(element));
                if (scrollable) {
                    element.setAttribute("devin-scrollable", "true");
                } else {
                    element.removeAttribute("devin-scrollable");
                }
                idToElementMap.set(element.getAttribute("devinid"), element);
            } else {
                element.removeAttribute("devinid");
            }

            // If a textbox has text in it, set this text as an attribute.
            if ((element.matches("input") || element.matches("textarea")) && element.value) {
                if (element.type === "password") {
                    element.setAttribute("text", "*".repeat(element.value.length));
                } else {
                    element.setAttribute("text", element.value);
                }
            } else {
                element.removeAttribute("text");
            }
            // If a select has a selected index, set this index as an attribute.
            if (element.matches("select")) {
                if (typeof element.selectedIndex !== "undefined") {
                    element.setAttribute("selectedIndex", element.selectedIndex);
                } else {
                    element.removeAttribute("selectedIndex");
                }
            }

            const childNodes = getChildNodes(element);

            for (const child of childNodes) {
                traverse(child, depth + 1);
            }
            if (element.matches("select")) {
                // Mark child options with their index
                for (const option of element.children) {
                    if (!option.matches("option")) continue;
                    if (option.selected) {
                        option.setAttribute("selected", "true");
                    }
                    option.setAttribute("index", option.index);
                }
            }
        }
        return true;
    }
    const traverseStoppedEarly = !traverse(document.documentElement);

    // tag all frames so we can acess them after cloning
    for (const frame of document.querySelectorAll('iframe, frame')) {
        frame.setAttribute("devin-frame", Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15));
    }

    // Return a simplified DOM tree.
    const simplify = (element, depth = 0) => {
        if (depth > 500) {
            return null;
        }
        if (!element) {
            return false;
        }
        if (element.nodeType === Node.TEXT_NODE && element.textContent?.trim()) {
            return document.createTextNode(element.textContent);
        }

        if (!isElement(element)) {
            return null;
        }

        // If element is an iframe, just return the element; we'll process it in Python.
        if (element.getAttribute("devin-hidden") !== "true" && isIframe(element)) {
            return element.cloneNode(true);
        }

        if (element.getAttribute("devin-hidden") === "true") {
            return null;
        }

        const tn = tagName(element);
        if (!tn) {
            return null;
        }
        const simplifiedElement = document.createElement(tn);

        const allowedAttributes = [
            'aria-label',
            'aria-multiselectable',
            'aria-modal',
            'aria-expanded',
            'aria-selected',
            'data-selected',
            'data-name',
            'name',
            'type',
            'placeholder',
            'value',
            // 'role',
            'title',
            'devinid',
            'text',
            'href',
            'download',
            'selectedIndex',
            "selected",
            "index",
            "contenteditable",
            "tabindex",
            "devin-scrollable",
            "offscreen",
        ];
        // Add 'src' attribute for img tags
        if (element.tagName.toLowerCase() === 'img') {
            allowedAttributes.push('src');
        }
        for (const attr of allowedAttributes) {
            if (element.hasAttribute(attr)) {
                if (!(attr == 'value' && element.tagName == 'INPUT')) {
                    // For input, show text attribute instead of value.
                    simplifiedElement.setAttribute(attr, element.getAttribute(attr));
                }
                // Truncate src and href attributes if over 50 chars
                if (attr === 'src' || attr === 'href') {
                    let maxLength = 50;
                    if (attr === 'src' && (element.getAttribute(attr).startsWith('blob:')
                        || element.getAttribute(attr).startsWith('data:'))) {
                        maxLength = 30;
                    }
                    if (element.getAttribute(attr).length > maxLength) {
                        const truncatedValue = element.getAttribute(attr).substring(0, maxLength - 3) + '...';
                        simplifiedElement.setAttribute(attr, truncatedValue);
                    }
                }
            }
        }

        // make sure its clear what portaled tooltips are (often theres no easy way to connect them to whats hoverered, but labelling as tooltip helps)
        if (element.getAttribute('role') === 'tooltip') {
            simplifiedElement.setAttribute('role', 'tooltip');
        }

        if (element.disabled) {
            simplifiedElement.setAttribute('disabled', 'true');
            simplifiedElement.removeAttribute('devinid');
        }

        const childNodes = getChildNodes(element)
        const children = childNodes ? Array.from(childNodes).map(child => simplify(child, depth + 1)).filter((child) => child !== null).flat() : [];

        const attrs = element.attributes ? Array.from(element.attributes) : [];
        const hasOtherAttrs = attrs.some(attr => allowedAttributes.includes(attr.name) && attr.name !== 'devinid');

        // whitelisted tags are tags that dont get removed if they are just a wrapper around a single or no elements
        const whitelistedTags = ['input', 'textarea', 'img', 'button', 'svg'];
        const whitelisted = element.matches(whitelistedTags.join(', '));
        if (children.length === 0 && (!element.hasAttribute('devinid') || !hasOtherAttrs) && !whitelisted) {
            if (debug) {
                element.setAttribute("devin-hidden-reason", "no_children");
            }
            return null;
        }
        if (children.length === 1 && element.hasAttribute('devinid') && !hasOtherAttrs && isElement(children[0]) && children[0].hasAttribute('devinid') && !whitelisted){
            if (debug) {
                element.setAttribute("devin-hidden-reason", "only_child");
            }
            return children[0];
        }
        if (element.matches('strong') && !element.hasAttribute('devinid') && !hasOtherAttrs) {
            return children;
        }
        // TODO: Think this through more.
        // if (children.length > 1 && element.hasAttribute('devinid')) {
        //     for (const child of children) {
        //         let shouldReturnAllChildren = true;
        //         if (!((child instanceof HTMLElement || child instanceof SVGElement) && child.hasAttribute('devinid'))) {
        //             shouldReturnAllChildren = false;
        //             break;
        //         }
        //         if (shouldReturnAllChildren) {
        //             return children;
        //         }
        //     }
        // }
        if (children.length === 1 && !element.hasAttribute('devinid') && element.matches('div, p, span, body, html')) {
            // put newlines after text nodes that are not spans
            if (children[0] && children[0].nodeType === Node.TEXT_NODE && element.tagName.toLowerCase() !== "span") {
                return [children[0], document.createTextNode("\n")];
            }
            return children[0];
        }

        if (!element.matches('svg')) {
            for (const child of children) {
                simplifiedElement.appendChild(child);
            }
        }

        return simplifiedElement;
    }

    const findElementIncludingSelf = (element, selector) => {
        if (element.matches(selector)) {
            return element;
        }
        return element.querySelector(selector);
    }

    // get the simplified DOM tree (this is a clone of the original DOM tree, so we can edit it)
    const simplified = simplify(document.documentElement);
    // Remove gaps in generated devinids.
    if (simplified) {
        for (let i = interactiveElementCount; i < tentativeInteractiveElementCount; ++i) {
            const element = findElementIncludingSelf(simplified, `[devinid="${i}"]`);
            if (element) {
                element.setAttribute("devinid", interactiveElementCount++);
                idToElementMap.get(String(i)).setAttribute("devinid", String(interactiveElementCount - 1));
            } else {
                idToElementMap.get(String(i)).removeAttribute("devinid");
            }
        }
    }

    // merges text nodes that are adjacent to each other, separating them from other nodes with newlines.
    function mergeTextNodesWithNewlines(nodes) {
        const mergedNodes = [];
        let currentText = '';
        for (const node of (nodes || [])) {
            if (!node) continue;
            if (node.nodeType === Node.TEXT_NODE) {
                currentText += node.textContent;
            } else {
                if (currentText) {
                    mergedNodes.push(document.createTextNode(currentText));
                    mergedNodes.push(document.createTextNode("\n"));
                    currentText = '';
                }
                mergedNodes.push(node);
            }
        }
        if (currentText) {
            mergedNodes.push(document.createTextNode(currentText));
            mergedNodes.push(document.createTextNode("\n"));
        }
        return mergedNodes;
    }

    // mark all valid iframes so they can be easily replaced with the html of the frame in python.
    const frames = simplified ? Array.from(simplified.querySelectorAll('iframe, frame')) : [];
    const childFrames = frames.filter(frame => {
        try {
            const originalFrame = document.querySelector(`[devin-frame="${frame.getAttribute("devin-frame")}"]`);
            if(originalFrame.getAttribute("devin-hidden") === "true") return false;
            if(!originalFrame.isConnected || originalFrame.contentWindow === null) return false;
            return true;
        } catch (err) {
            return false;
        }
    }).map(frame => {
        // replace each frame with just a simple marker of where it is.
        // these will be replaced with the html of the frame in python, and we need them to be
        // easy to replace with a regex. Normal html replacing with regex wouldn't be safe.
        const newFrame = document.createTextNode(`[framemarker${frame.getAttribute("devin-frame")}]`);
        frame.replaceWith(newFrame);
        return newFrame.textContent;
    });

    // further simplify the DOM tree.
    // this behavior is copied from the python code. its probably mostly redundant with simplify.
    function clean(node) {
        if (node === null || node === undefined || node.nodeType === Node.TEXT_NODE || (isElement(node) && node.hasAttribute("devinid"))) {
            return node;
        }

        let newChildren = [];
        for (const child of getChildNodes(node)) {
            if (child.nodeType === Node.TEXT_NODE) {
                newChildren.push(child);
            } else {
                const cleaned = clean(child);
                if (cleaned !== null) {
                    if (Array.isArray(cleaned)) {
                        newChildren.push(...cleaned);
                    } else {
                        newChildren.push(cleaned);
                    }
                }
            }
        }

        newChildren = mergeTextNodesWithNewlines(newChildren);

        if (["div", "p", "span", "body", "html"].includes(node.tagName.toLowerCase())) {
            // put newlines after text nodes that are not spans
            if (node.tagName.toLowerCase() !== "span" && newChildren.length === 1 && newChildren[0].nodeType === Node.TEXT_NODE) {
                return [newChildren[0], document.createTextNode("\n")];
            }
            return newChildren;
        } else {
            node.textContent = '';
            for (const child of newChildren) {
                node.appendChild(child);
            }
            return node;
        }
    }

    const extraCleanup = (node) => {
        // if the parent is offscreen, and the child is not, remove the offscreen attribute from the child
        if (node.hasAttribute("offscreen") && node.parentElement && node.parentElement.hasAttribute("offscreen")) {
            node.removeAttribute("offscreen");
        }
    }

    const escapeValue = (str) => {
        return str.replace(/&/g, '&amp;')
                 .replace(/"/g, '&quot;')
                 .replace(/'/g, '&#39;')
                 .replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;')
    };

    // pretty print the DOM tree.
    function prettyPrintHTML(element, includeOwnTag = true) {
        if (!element) return '';
        if (element.nodeType === Node.TEXT_NODE) {
            let content = element.textContent.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n');
            content = escapeValue(content);
            if (content.length < 25) {
                return content.replace(/\n/g, ' ').trim();
            }
            return content;
        }

        if (element.nodeType === Node.ELEMENT_NODE) {
            let result = '';
            extraCleanup(element);
            const children = mergeTextNodesWithNewlines(Array.from(element.childNodes));
            const tagName = element.tagName.toLowerCase();
            const attributes = Array.from(element.attributes)
                .filter(attr => !(stripDevinId && attr.name === 'devinid'))
                // sort devinids to the start
                .sort((a, b) => {
                    if (a.name === 'devinid') return -1;
                    if (b.name === 'devinid') return 1;
                    return 0;
                })
                .map(attr => `${attr.name}="${escapeValue(attr.value)}"`)
                .join(' ');
            const openTag = `<${tagName}${attributes ? ' ' + attributes : ''}>`;
            const closeTag = `</${tagName}>`;

            if (includeOwnTag) {
                result = openTag;
                const isSelfClosing = ['area', 'base', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'menuitem'].includes(tagName);
                if (children.length === 0 && isSelfClosing) {
                    return result.slice(0, -1) + '/>';
                }
            }

            for (const child of children) {
                const childResult = prettyPrintHTML(child);
                if (childResult.trim()) {
                    result += '\n' + childResult;
                }
            }
            if (includeOwnTag) {
                result += '\n' + closeTag;
            }

            // see if we can collapse the result into a single line.
            const lines = result.split('\n').filter(line => line.trim());
            const shouldCollapse = result.length < 70 || (openTag.length < 12 && result.length < 140) || (!lines[1].includes('<') && result.length < 150);
            if (lines.length === 3 && shouldCollapse) {
                return lines[0] + lines[1] + lines[2];
            }

            return result;
        }

        return '';
    }

    // get the final simplified DOM tree.
    const cleaned = clean(simplified);

    // get the final simplified DOM tree as a string.
    let dom = "";
    if (cleaned instanceof Text) {
        dom = cleaned.textContent;
    } else if (Array.isArray(cleaned)) {
        // this is when the outermost node should be removed from the DOM
        const div = document.createElement('div');
        div.append(...mergeTextNodesWithNewlines(cleaned));
        dom = prettyPrintHTML(div, false);
    } else {
        dom = prettyPrintHTML(cleaned);
    }

    // include the doctype in the original dom
    const original_dom = (document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '') + document.documentElement.outerHTML;

    return {
        original_dom,
        // snake_case because the result is used in Python code
        interactive_element_count: interactiveElementCount,
        dom,
        traverse_stopped_early: traverseStoppedEarly,
        child_frames: childFrames,
    };
}